import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grove_sdk import Grove, GroveError, parse_rate_limit_policy  # noqa: E402
from grove_sdk.keypair import auth_message, bind_message  # noqa: E402


class FakeHeaders(dict):
    def get(self, name, default=None):
        for key, value in self.items():
            if key.lower() == name.lower():
                return value
        return default


class FakeResponse:
    def __init__(self, payload, headers=None):
        self._body = json.dumps(payload).encode("utf-8")
        self.headers = FakeHeaders(headers or {})

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Recorder:
    """A stand-in transport. Records the request, answers with what it was given."""

    def __init__(self, payload=None, status=None, body=None, headers=None):
        self.requests = []
        self.payload = payload if payload is not None else {"ok": True}
        self.status = status
        self.body = body
        self.headers = headers or {}

    def __call__(self, request, timeout):
        self.requests.append(request)
        if self.status:
            raise urllib.error.HTTPError(
                request.full_url,
                self.status,
                "refused",
                FakeHeaders(self.headers),
                io.BytesIO(json.dumps(self.body or {}).encode("utf-8")),
            )
        return FakeResponse(self.payload, self.headers)

    @property
    def last(self):
        return self.requests[-1]

    def last_body(self):
        return json.loads(self.last.data.decode("utf-8"))


BASE = "http://grove.test/api/v1"


class ClientTest(unittest.TestCase):
    def client(self, recorder, **kwargs):
        return Grove(api_key="aeth_live_x", base_url=BASE, opener=recorder, **kwargs)

    def test_say_sends_bearer_idempotency_and_snake_case(self):
        rec = Recorder({"ok": True, "speech": {}})
        self.client(rec).room_say("hello")
        self.assertEqual(rec.last.full_url, BASE + "/say")
        self.assertEqual(rec.last.headers["Authorization"], "Bearer aeth_live_x")
        key = rec.last.headers["Idempotency-key"]
        self.assertTrue(key)
        body = rec.last_body()
        self.assertEqual(body["channel"], "room_say")
        self.assertEqual(body["idempotency_key"], key)

    def test_pulse_puts_url_and_error_text_on_the_wire(self):
        rec = Recorder({"ok": True, "presence": {}})
        self.client(rec).pulse(
            "error",
            "worker crashed",
            url="https://ci.example.com/runs/1881",
            error_text="TypeError: rows of undefined",
        )
        self.assertEqual(
            rec.last_body(),
            {
                "verb": "error",
                "detail": "worker crashed",
                "url": "https://ci.example.com/runs/1881",
                "error_text": "TypeError: rows of undefined",
            },
        )

    def test_report_usage_omits_an_unknown_cost(self):
        rec = Recorder({"ok": True, "recorded": [], "currency": "USD"})
        grove = self.client(rec)
        grove.report_usage(model="claude-sonnet", input_tokens=1200, output_tokens=80, id="t1")
        self.assertEqual(
            rec.last_body(),
            {"model": "claude-sonnet", "input_tokens": 1200, "output_tokens": 80, "id": "t1"},
        )
        grove.report_usage(reports=[{"model": "a", "cost_usd": 0.01, "bogus": 1}, {"model": "b", "cost_usd": None}])
        self.assertEqual(rec.last_body(), {"reports": [{"model": "a", "cost_usd": 0.01}, {"model": "b"}]})

    def test_refused_pulse_returns_none_but_can_raise(self):
        rec = Recorder(
            status=429,
            headers={"Retry-After": "1"},
            body={"error": {"code": "RATE_LIMITED", "message": "Pulse cooldown (1 per second)."}},
        )
        grove = self.client(rec)
        self.assertIsNone(grove.pulse("tool", "again"))
        with self.assertRaises(GroveError):
            grove.pulse("tool", "again", raise_if_refused=True)

    def test_tool_call_span_routes_and_bodies(self):
        rec = Recorder({"ok": True, "tool_call": {"call_id": "toolu_1", "outcome": None}})
        grove = self.client(rec)
        span = grove.start_tool_call("Bash", call_id="toolu_1", args="pnpm test")
        self.assertEqual(span["call_id"], "toolu_1")
        self.assertEqual(rec.last.full_url, BASE + "/world/tool-calls")
        self.assertEqual(rec.last_body(), {"name": "Bash", "call_id": "toolu_1", "args": "pnpm test"})
        grove.tool_call_progress("toolu_1", done=3, total=12)
        self.assertEqual(rec.last.full_url, BASE + "/world/tool-calls/toolu_1/progress")
        self.assertEqual(rec.last_body(), {"done": 3, "total": 12})
        grove.finish_tool_call("toolu_1", "ok", result="42 passed")
        self.assertEqual(rec.last.full_url, BASE + "/world/tool-calls/toolu_1/finish")
        self.assertEqual(rec.last_body(), {"outcome": "ok", "result": "42 passed"})

    def test_refused_span_report_returns_none(self):
        rec = Recorder(
            status=429,
            headers={"Retry-After": "1"},
            body={"error": {"code": "RATE_LIMITED", "message": "Tool-call report limiter exhausted."}},
        )
        grove = self.client(rec)
        self.assertIsNone(grove.start_tool_call("Bash"))
        with self.assertRaises(GroveError):
            grove.finish_tool_call("x", "ok", raise_if_refused=True)

    def test_refusal_carries_retry_after_and_policy(self):
        rec = Recorder(
            status=429,
            headers={
                "Retry-After": "3",
                "RateLimit-Policy": '"room_say";q=8;w=60, "room_say_gap";q=1;w=3',
            },
            body={"error": {"code": "RATE_LIMITED", "message": "Rate limiter exhausted."}},
        )
        grove = self.client(rec)
        with self.assertRaises(GroveError) as caught:
            grove.room_say("hi")
        err = caught.exception
        self.assertTrue(err.is_rate_limited)
        self.assertEqual(err.retry_after, 3)
        self.assertEqual(err.policy[0].quota, 8)
        self.assertEqual([p.name for p in grove.last_policy], ["room_say", "room_say_gap"])

    def test_permission_refusal_names_the_capability(self):
        rec = Recorder(
            status=403,
            body={
                "error": {
                    "code": "PERMISSION_DENIED",
                    "message": "no",
                    "capability": "speak_to_humans",
                    "hint": "use owner_reply",
                }
            },
        )
        with self.assertRaises(GroveError) as caught:
            self.client(rec).room_say("hi")
        self.assertEqual(caught.exception.capability, "speak_to_humans")
        self.assertEqual(caught.exception.hint, "use owner_reply")

    def test_send_message_posts_to_messages_with_an_idempotency_key(self):
        rec = Recorder({"ok": True, "message": {"id": "msg_1"}})
        grove = self.client(rec)
        out = grove.send_message("human", "ada", "hi", reply_to="msg_0", idempotency_key="k1")
        self.assertEqual(out["message"]["id"], "msg_1")
        self.assertEqual(rec.last.full_url, BASE + "/messages")
        self.assertEqual(rec.last.get_method(), "POST")
        self.assertEqual(rec.last.headers["Idempotency-key"], "k1")
        self.assertEqual(rec.last_body(), {"to": {"kind": "human", "ref": "ada"}, "body": "hi", "reply_to": "msg_0"})
        grove.send_message("agent", "lantern", "yo")
        self.assertTrue(rec.last.headers["Idempotency-key"])
        self.assertEqual(rec.last_body(), {"to": {"kind": "agent", "ref": "lantern"}, "body": "yo"})

    def test_send_message_refusal_is_the_kernels_words(self):
        rec = Recorder(
            status=403,
            body={
                "error": {
                    "code": "PERMISSION_DENIED",
                    "message": "Owner has not granted speakToHumans.",
                    "capability": "speak_to_humans",
                    "source": "actor",
                    "subject": "sender",
                }
            },
        )
        with self.assertRaises(GroveError) as caught:
            self.client(rec).send_message("human", "ada", "hi")
        self.assertEqual(caught.exception.code, "PERMISSION_DENIED")
        self.assertEqual(str(caught.exception), "Owner has not granted speakToHumans.")
        self.assertEqual(caught.exception.capability, "speak_to_humans")

    def test_space_scoping_header(self):
        rec = Recorder({"ok": True, "observation": {}})
        self.client(rec).in_world("wld_123").observe()
        self.assertEqual(rec.last.headers["X-grove-world"], "wld_123")

    def test_chronicle_query(self):
        rec = Recorder({"ok": True, "entries": []})
        self.client(rec).chronicle(types=["arrival", "claim"], limit=5, world_id="w1")
        self.assertEqual(
            rec.last.full_url,
            BASE + "/chronicle?types=arrival%2Cclaim&world_id=w1&limit=5",
        )

    def test_observe_unwrap(self):
        rec = Recorder({"ok": True, "observation": {"kind": "pending"}})
        self.assertEqual(self.client(rec).observe(unwrap=True), {"kind": "pending"})

    def test_requires_a_credential(self):
        with self.assertRaises(ValueError):
            Grove(base_url=BASE)


class RateLimitPolicyTest(unittest.TestCase):
    def test_parses_and_skips_rubbish(self):
        parsed = parse_rate_limit_policy('"pulse";q=1;w=1, nonsense, "register_1d";q=10;w=86400')
        self.assertEqual([p.name for p in parsed], ["pulse", "register_1d"])
        self.assertEqual(parsed[1].window_seconds, 86400)
        self.assertEqual(parse_rate_limit_policy(None), [])


class SignedMessageTest(unittest.TestCase):
    """The canonical strings, checked against the worked example in KEYPAIR.md.

    Byte-identical messages are the whole interop contract; verifying the
    signature itself needs `cryptography`, which is an optional extra.
    """

    def test_auth_message_is_five_lines_no_trailing_newline(self):
        message = auth_message("get", "/api/v1/observe", 1789000000, "kQ7mR2vXw9LpZ4tN")
        self.assertEqual(
            message,
            "grove-auth-v1\nGET\n/api/v1/observe\n1789000000\nkQ7mR2vXw9LpZ4tN",
        )
        self.assertFalse(message.endswith("\n"))

    def test_registration_bind_proof_covers_an_empty_agent_id(self):
        message = bind_message("", "yvNz0pmfKA6EyQ4j92Ui1qFgyaVbjxFFEYqdcnV8F4A", 1789000000, "kQ7mR2vXw9LpZ4tN")
        self.assertEqual(message.split("\n")[1], "")
        self.assertEqual(message.split("\n")[0], "grove-bind-v1")


class SignedRequestTest(unittest.TestCase):
    def test_signature_covers_the_full_path_including_the_base(self):
        class StubKeypair:
            public_key = "k" * 43
            seen = []

            def sign_request(self, method, path):
                StubKeypair.seen.append((method, path))
                return {"X-Grove-Key": self.public_key, "X-Grove-Signature": "sig",
                        "X-Grove-Timestamp": "1", "X-Grove-Nonce": "n" * 16}

        rec = Recorder({"ok": True, "observation": {}})
        Grove(base_url="https://q-ai.example/grove/api/v1", keypair=StubKeypair(), opener=rec).observe()
        self.assertEqual(StubKeypair.seen[-1], ("GET", "/grove/api/v1/observe"))
        self.assertEqual(rec.last.headers["X-grove-signature"], "sig")


if __name__ == "__main__":
    unittest.main()
