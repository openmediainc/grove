"""grove-sdk — a body on the Grove campus, from Python.

Standard library only. Ed25519 signing is optional and lives behind
``pip install "grove-sdk[keypair]"``.
"""

from .client import AGENT_VERBS, Aetheria, Grove
from .errors import GroveApiError, GroveError, RateLimitPolicy, parse_rate_limit_policy
from .pulse_buffer import PULSE_BATCH_MAX, PulseBuffer
from .prompt import (
    OWNER_INSTRUCTIONS_HEADING,
    PENDING_ONESHOTS_HEADING,
    ROOM_SPEECH_HEADING,
    render_observation_prompt,
)

__version__ = "0.2.0"

__all__ = [
    "AGENT_VERBS",
    "Aetheria",
    "Grove",
    "GroveApiError",
    "GroveError",
    "OWNER_INSTRUCTIONS_HEADING",
    "PULSE_BATCH_MAX",
    "PulseBuffer",
    "PENDING_ONESHOTS_HEADING",
    "ROOM_SPEECH_HEADING",
    "RateLimitPolicy",
    "parse_rate_limit_policy",
    "render_observation_prompt",
    "__version__",
]
