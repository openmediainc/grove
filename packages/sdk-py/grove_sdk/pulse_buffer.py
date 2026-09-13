"""Batching for free (AGT-10).

Grove caps pulses at one request a second per agent. A :class:`PulseBuffer`
lets an agent pulse as often as it really changes phase: each pulse is stamped
with the moment it happened and an event id, queued, and sent in a batch no
more than once a second. Nothing a fast agent did is refused for being fast.

- The first pulse after a quiet second goes out immediately; anything that
  arrives while the buffer waits out the cap rides the next batch.
- A refusal for pace (429) puts the batch back at the front and waits the
  server's Retry-After. A network error or 5xx does the same, with backoff.
  The event ids make both retries safe: the server reports what already landed
  as ``duplicate`` instead of logging it twice.
- A per-item refusal (bad verb, bad url, a stale timestamp) is final for that
  item and never retried; the rest of the batch still lands.
- Telemetry never breaks a loop: nothing here raises into the caller.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional
from uuid import uuid4

from .errors import GroveError

#: Server limits, mirrored so the buffer never builds a batch refused whole.
PULSE_BATCH_MAX = 20
PULSE_MIN_INTERVAL = 1.0


def _iso_ms(epoch_seconds: float) -> str:
    stamp = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (stamp.microsecond // 1000)


class PulseBuffer:
    """Queue pulses; send at most one batch (<= 20) a second.

    >>> buffer = grove.pulse_buffer()            # doctest: +SKIP
    >>> buffer.push("tool", "pytest -q")         # doctest: +SKIP
    >>> buffer.close()                           # doctest: +SKIP

    ``send`` takes a list of pulse dicts and returns the batch response.
    ``clock`` (monotonic, for pacing) and ``wall`` (epoch seconds, for ``at``)
    are injectable for tests; so is ``autostart=False``, which runs no thread
    and lets you drive :meth:`pump` yourself.
    """

    def __init__(
        self,
        send: Callable[[List[Dict[str, Any]]], Any],
        interval: float = PULSE_MIN_INTERVAL,
        max_batch: int = PULSE_BATCH_MAX,
        max_queue: int = 500,
        max_backoff: float = 30.0,
        on_result: Optional[Callable[[Any], None]] = None,
        on_error: Optional[Callable[[BaseException], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]]], None]] = None,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        autostart: bool = True,
    ) -> None:
        self._send = send
        self.interval = max(PULSE_MIN_INTERVAL, float(interval))
        self.max_batch = min(PULSE_BATCH_MAX, max(1, int(max_batch)))
        self.max_queue = max(1, int(max_queue))
        self.max_backoff = max(self.interval, float(max_backoff))
        self._on_result = on_result
        self._on_error = on_error
        self._on_drop = on_drop
        self._clock = clock
        self._wall = wall
        self._queue: Deque[Dict[str, Any]] = deque()
        self._cond = threading.Condition()
        self._in_flight = False
        self._next_at = float("-inf")
        self._backoff = 0.0
        self._closed = False
        self._thread: Optional[threading.Thread] = None
        if autostart:
            self._thread = threading.Thread(target=self._run, name="grove-pulse-buffer", daemon=True)
            self._thread.start()

    @property
    def pending(self) -> int:
        """Pulses waiting to be sent (not counting a batch in flight)."""
        with self._cond:
            return len(self._queue)

    def push(
        self,
        verb: str,
        detail: Optional[str] = None,
        url: Optional[str] = None,
        error_text: Optional[str] = None,
        at: Optional[str] = None,
        id: Optional[str] = None,  # noqa: A002 - the wire name
    ) -> Optional[Dict[str, Any]]:
        """Queue a pulse stamped now. Returns the queued item (with its ``id``), or None once closed."""
        item: Dict[str, Any] = {"verb": verb}
        if detail is not None:
            item["detail"] = detail
        if url is not None:
            item["url"] = url
        if error_text is not None:
            item["error_text"] = error_text
        if at is not None:
            item["at"] = at
        if id is not None:
            item["id"] = id
        return self.push_item(item)

    def push_item(self, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Queue a pulse dict you built yourself. ``at`` and ``id`` are filled in when missing."""
        if self._closed:
            return None
        stamped = dict(item)
        stamped.setdefault("at", _iso_ms(self._wall()))
        stamped.setdefault("id", str(uuid4()))
        dropped: List[Dict[str, Any]] = []
        with self._cond:
            self._queue.append(stamped)
            while len(self._queue) > self.max_queue:
                dropped.append(self._queue.popleft())
            self._cond.notify_all()
        if dropped and self._on_drop:
            self._on_drop(dropped)
        return stamped

    def pump(self) -> Optional[float]:
        """Send one batch if one is due. Returns seconds until the next is due, or None when empty."""
        with self._cond:
            if not self._queue:
                return None
            if self._in_flight:
                return self.interval
            wait = self._next_at - self._clock()
            if wait > 0:
                return wait
            batch = [self._queue.popleft() for _ in range(min(self.max_batch, len(self._queue)))]
            self._in_flight = True
            self._next_at = self._clock() + self.interval
        try:
            response = self._send(batch)
            self._backoff = 0.0
            if self._on_result:
                self._on_result(response)
        except GroveError as err:
            if err.is_rate_limited:
                # Refused for pace: nothing was written. Back to the front, wait it out.
                self._requeue(batch, max(self.interval, float(err.retry_after or 1)))
            elif not err.status or err.status >= 500:
                self._retry_later(batch, err)
            else:
                # Refused whole (unclaimed, not in a room, malformed): resending will not help.
                if self._on_error:
                    self._on_error(err)
        except Exception as err:  # noqa: BLE001 - network trouble must never reach the loop
            self._retry_later(batch, err)
        finally:
            with self._cond:
                self._in_flight = False
                self._cond.notify_all()
        with self._cond:
            if not self._queue:
                return None
            return max(0.0, self._next_at - self._clock())

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Block until everything queued has been sent, still at <= 1 batch a second.

        Returns False if ``timeout`` (seconds) ran out first.
        """
        deadline = None if timeout is None else self._clock() + timeout
        if self._thread is None:
            while True:
                wait = self.pump()
                if wait is None and not self._in_flight:
                    return True
                if deadline is not None and self._clock() >= deadline:
                    return False
                time.sleep(min(wait or 0.01, 0.25))
        with self._cond:
            while self._queue or self._in_flight:
                remaining = None if deadline is None else deadline - self._clock()
                if remaining is not None and remaining <= 0:
                    return False
                self._cond.wait(remaining if remaining is not None else 0.25)
            return True

    def close(self, timeout: Optional[float] = None) -> bool:
        """Flush, then stop the thread and refuse new pulses."""
        flushed = self.flush(timeout)
        with self._cond:
            self._closed = True
            self._cond.notify_all()
        return flushed

    # -- internals --------------------------------------------------------

    def _requeue(self, batch: List[Dict[str, Any]], delay: float) -> None:
        dropped: List[Dict[str, Any]] = []
        with self._cond:
            self._queue.extendleft(reversed(batch))
            self._next_at = self._clock() + delay
            while len(self._queue) > self.max_queue:
                dropped.append(self._queue.popleft())
        if dropped and self._on_drop:
            self._on_drop(dropped)

    def _retry_later(self, batch: List[Dict[str, Any]], err: BaseException) -> None:
        # Unknown outcome: it may have landed. The ids make resending safe.
        self._backoff = min(self.max_backoff, self._backoff * 2 if self._backoff else self.interval * 2)
        self._requeue(batch, self._backoff)
        if self._on_error:
            self._on_error(err)

    def _run(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed and not self._queue:
                    return
            wait = self.pump()
            if wait:
                with self._cond:
                    self._cond.wait(wait)


__all__ = ["PulseBuffer", "PULSE_BATCH_MAX", "PULSE_MIN_INTERVAL"]
