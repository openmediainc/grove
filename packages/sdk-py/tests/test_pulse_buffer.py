"""Batch pulse from Python (AGT-10): pulse_batch, PulseBuffer, buffer_pulses."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grove_sdk import PULSE_BATCH_MAX, Grove, GroveError, PulseBuffer  # noqa: E402

BASE = "http://grove.test/api/v1"


class FakeClock:
    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeCampus:
    """Answers a batch the way Grove does: one result per item, in order.

    ``script`` maps a call number (0-based) to an exception to raise instead.
    """

    def __init__(self, script=None, clock=None):
        self.calls = []
        self.script = script or {}
        self.clock = clock

    def __call__(self, items):
        n = len(self.calls)
        self.calls.append({"at": self.clock() if self.clock else None, "items": [dict(i) for i in items]})
        if n in self.script:
            raise self.script[n]
        return {
            "ok": True,
            "presence": {"verb": items[-1]["verb"]},
            "results": [
                {"index": i, "id": it.get("id"), "status": "applied", "verb": it["verb"], "pulsed_at": it.get("at"), "clamped": False}
                for i, it in enumerate(items)
            ],
            "applied": len(items),
            "duplicates": 0,
            "refused": 0,
        }


def rate_limited(retry_after=1):
    return GroveError(code="RATE_LIMITED", message="Pulse cooldown", status=429, retry_after=retry_after)


class PulseBatchWireTest(unittest.TestCase):
    def test_pulse_batch_posts_pulses_to_the_pulse_route(self):
        from test_client import Recorder  # the transport stand-in the client suite uses

        rec = Recorder({"ok": True, "results": [], "applied": 0, "duplicates": 0, "refused": 0})
        grove = Grove(api_key="k", base_url=BASE, opener=rec)
        grove.pulse_batch([
            {"verb": "think", "at": "2026-09-13T12:00:00.000Z", "id": "e1"},
            {"verb": "tool", "detail": "pytest -q", "at": "2026-09-13T12:00:00.400Z", "id": "e2"},
        ])
        self.assertEqual(rec.last.full_url, BASE + "/world/pulse")
        self.assertEqual(
            rec.last_body(),
            {
                "pulses": [
                    {"verb": "think", "at": "2026-09-13T12:00:00.000Z", "id": "e1"},
                    {"verb": "tool", "detail": "pytest -q", "at": "2026-09-13T12:00:00.400Z", "id": "e2"},
                ]
            },
        )

    def test_refused_batch_returns_none_but_can_raise(self):
        from test_client import Recorder

        rec = Recorder(status=429, headers={"Retry-After": "1"}, body={"error": {"code": "RATE_LIMITED", "message": "x"}})
        grove = Grove(api_key="k", base_url=BASE, opener=rec)
        self.assertIsNone(grove.pulse_batch([{"verb": "tool"}]))
        with self.assertRaises(GroveError):
            grove.pulse_batch([{"verb": "tool"}], raise_if_refused=True)


class PulseBufferTest(unittest.TestCase):
    def make(self, campus=None, **kwargs):
        clock = FakeClock()
        wall = FakeClock(start=1789300800.0)  # 2026-09-13T12:00:00Z
        campus = campus or FakeCampus(clock=clock)
        campus.clock = clock
        buffer = PulseBuffer(campus, clock=clock, wall=wall, autostart=False, **kwargs)
        return buffer, campus, clock, wall

    def test_first_pulse_goes_at_once_and_a_burst_rides_the_next_batch(self):
        buffer, campus, clock, wall = self.make()
        buffer.push("think", "planning")
        self.assertIsNone(buffer.pump())
        self.assertEqual(len(campus.calls), 1)

        for verb, step in (("read", 0.1), ("tool", 0.1), ("idle", 0.1)):
            clock.advance(step)
            wall.advance(step)
            buffer.push(verb)
        wait = buffer.pump()
        self.assertEqual(len(campus.calls), 1, "still inside the second")
        self.assertAlmostEqual(wait, 0.7, places=6)

        clock.advance(wait)
        buffer.pump()
        self.assertEqual(len(campus.calls), 2)
        batch = campus.calls[1]["items"]
        self.assertEqual([p["verb"] for p in batch], ["read", "tool", "idle"])
        self.assertEqual(
            [p["at"] for p in batch],
            ["2026-09-13T12:00:00.100Z", "2026-09-13T12:00:00.200Z", "2026-09-13T12:00:00.300Z"],
        )
        self.assertEqual(len({p["id"] for p in batch}), 3)

    def test_never_more_than_one_batch_a_second_nor_more_than_twenty(self):
        buffer, campus, clock, _ = self.make()
        for i in range(50):
            buffer.push("tool", "step %d" % i)
        while True:
            wait = buffer.pump()
            if wait is None:
                break
            clock.advance(wait)
        self.assertEqual([len(c["items"]) for c in campus.calls], [20, 20, 10])
        gaps = [b["at"] - a["at"] for a, b in zip(campus.calls, campus.calls[1:])]
        self.assertTrue(all(g >= 1.0 for g in gaps), gaps)
        self.assertEqual(
            [p["detail"] for c in campus.calls for p in c["items"]], ["step %d" % i for i in range(50)]
        )
        self.assertEqual(PULSE_BATCH_MAX, 20)

    def test_refused_for_pace_is_resent_with_the_same_ids_after_retry_after(self):
        campus = FakeCampus(script={0: rate_limited(retry_after=2)})
        buffer, campus, clock, _ = self.make(campus)
        buffer.push("tool", "pytest -q")
        wait = buffer.pump()
        self.assertEqual(len(campus.calls), 1)
        self.assertAlmostEqual(wait, 2.0)
        clock.advance(1.5)
        buffer.pump()
        self.assertEqual(len(campus.calls), 1)
        clock.advance(0.5)
        self.assertIsNone(buffer.pump())
        self.assertEqual(len(campus.calls), 2)
        self.assertEqual(campus.calls[1]["items"][0]["id"], campus.calls[0]["items"][0]["id"])

    def test_network_failure_is_retried_with_the_same_ids(self):
        errors = []
        campus = FakeCampus(script={0: OSError("connection refused")})
        buffer, campus, clock, _ = self.make(campus, on_error=errors.append)
        buffer.push("read")
        wait = buffer.pump()
        self.assertEqual(wait, 2.0)
        clock.advance(wait)
        buffer.pump()
        self.assertEqual(len(campus.calls), 2)
        self.assertEqual(campus.calls[1]["items"][0]["id"], campus.calls[0]["items"][0]["id"])
        self.assertEqual(len(errors), 1)

    def test_batch_refused_whole_for_a_permanent_reason_is_not_retried(self):
        errors = []
        campus = FakeCampus(script={0: GroveError(code="UNCLAIMED", message="no", status=403)})
        buffer, campus, clock, _ = self.make(campus, on_error=errors.append)
        buffer.push("think")
        self.assertIsNone(buffer.pump())
        clock.advance(10)
        buffer.pump()
        self.assertEqual(len(campus.calls), 1)
        self.assertEqual(errors[0].code, "UNCLAIMED")

    def test_drops_the_oldest_beyond_max_queue_and_says_so(self):
        dropped = []
        buffer, _, _, _ = self.make(max_queue=3, on_drop=dropped.extend)
        for i in range(5):
            buffer.push("tool", str(i))
        self.assertEqual([d["detail"] for d in dropped], ["0", "1"])
        self.assertEqual(buffer.pending, 3)

    def test_never_raises_into_the_loop(self):
        campus = FakeCampus(script={0: RuntimeError("anything at all")})
        buffer, campus, _, _ = self.make(campus)
        buffer.push("error", error_text="boom")
        buffer.pump()  # does not raise
        self.assertEqual(buffer.pending, 1)


class BufferedClientTest(unittest.TestCase):
    def test_buffer_pulses_makes_plain_pulse_batch_on_a_thread(self):
        from test_client import Recorder

        rec = Recorder({"ok": True, "results": [], "applied": 0, "duplicates": 0, "refused": 0})
        grove = Grove(api_key="k", base_url=BASE, opener=rec, buffer_pulses=True)
        self.assertIsNone(grove.pulse("think", "planning"))
        grove.pulse("tool", "pytest -q", url="https://github.com/grove/grove/pull/42")
        grove.pulse("idle")
        self.assertTrue(grove.flush_pulses(timeout=5))
        sent = [p for r in rec.requests for p in __import__("json").loads(r.data.decode("utf-8"))["pulses"]]
        self.assertEqual([p["verb"] for p in sent], ["think", "tool", "idle"])
        self.assertTrue(all(r.full_url == BASE + "/world/pulse" for r in rec.requests))
        self.assertLessEqual(len(rec.requests), 2)
        self.assertEqual(sent[1]["url"], "https://github.com/grove/grove/pull/42")


if __name__ == "__main__":
    unittest.main()
