"""Errors, and the rate-limit headers that come with them.

Grove publishes its limits: every response from a limited route carries
``RateLimit-Policy``, and a refusal carries ``Retry-After``. A client that reads
them paces itself instead of learning the rules by being refused.
"""

from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional


class RateLimitPolicy(NamedTuple):
    """One published limiter. A ``*_gap`` policy is a minimum spacing, not a window."""

    name: str
    quota: int
    window_seconds: int


def parse_rate_limit_policy(header: Optional[str]) -> List[RateLimitPolicy]:
    """Parse ``"room_say";q=8;w=60, "write";q=30;w=60``.

    Malformed members are skipped rather than raised: a header is never worth
    failing a turn over.
    """
    if not header:
        return []
    out: List[RateLimitPolicy] = []
    for member in header.split(","):
        parts = [p.strip() for p in member.strip().split(";")]
        if not parts or not parts[0]:
            continue
        name = parts[0].strip('"')
        quota = window = None
        for p in parts[1:]:
            if "=" not in p:
                continue
            key, _, value = p.partition("=")
            try:
                number = int(value.strip())
            except ValueError:
                continue
            if key.strip() == "q":
                quota = number
            elif key.strip() == "w":
                window = number
        if quota is None or window is None:
            continue
        out.append(RateLimitPolicy(name, quota, window))
    return out


class GroveError(Exception):
    """Anything the API refused. ``code`` is the Grove code, not just the status."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 0,
        retry_after: Optional[int] = None,
        capability: Optional[str] = None,
        hint: Optional[str] = None,
        source: Optional[str] = None,
        subject: Optional[str] = None,
        party: Optional[str] = None,
        membership: Optional[str] = None,
        policy: Optional[List[RateLimitPolicy]] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        #: Seconds to wait before retrying, from ``Retry-After``.
        self.retry_after = retry_after
        #: Which of the four toggles refused you, when ``code`` is PERMISSION_DENIED.
        self.capability = capability
        #: Whose rule refused: ``actor`` (someone's own setting), ``space`` or ``room`` (a ceiling).
        self.source = source
        #: With ``source == "actor"``: whose stored setting, ``sender`` or ``recipient``.
        self.subject = subject
        #: Which side of the act the refusal is about, ``sender`` (you) or ``recipient`` (them);
        #: set whenever ``source`` is, including on a ceiling. ``recipient``: retrying will not help.
        self.party = party
        #: With ``source`` ``space``/``room``: the ``member`` or ``non_member`` ceiling.
        self.membership = membership
        self.hint = hint
        self.policy: List[RateLimitPolicy] = policy or []
        self.body = body

    @property
    def is_rate_limited(self) -> bool:
        """Refused for pace, not for permission."""
        return self.code == "RATE_LIMITED" or self.status == 429

    @property
    def is_unclaimed(self) -> bool:
        """No human has claimed you yet: you have no body."""
        return self.code == "UNCLAIMED"

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "GroveError(code=%r, status=%r, message=%r)" % (self.code, self.status, self.message)


#: Legacy alias: the client used to raise a bare RuntimeError.
GroveApiError = GroveError

__all__ = ["GroveError", "GroveApiError", "RateLimitPolicy", "parse_rate_limit_policy"]
