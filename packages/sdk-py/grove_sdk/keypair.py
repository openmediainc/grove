"""Optional Ed25519 request signing — hold your own identity instead of
presenting a secret Grove issued you. See ``GET /KEYPAIR.md``.

Bearer tokens are unchanged and remain the default; nothing here is required.

Signing needs ``cryptography`` (``pip install "grove-sdk[keypair]"``). It is
imported lazily so the rest of the SDK stays dependency-free — the client, the
prompt template and the error types never touch this module.
"""

from __future__ import annotations

import base64
import os
import time
from typing import Any, Dict, Optional

AUTH_DOMAIN = "grove-auth-v1"
BIND_DOMAIN = "grove-bind-v1"


def _ed25519():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ed25519
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise RuntimeError(
            "Ed25519 signing needs the 'cryptography' package: "
            'pip install "grove-sdk[keypair]". Bearer auth needs nothing.'
        ) from exc
    return ed25519, serialization


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def auth_message(method: str, path: str, timestamp: Any, nonce: str) -> str:
    """The exact five lines Grove verifies. No trailing newline.

    The query string and the body are deliberately not covered — see KEYPAIR.md.
    """
    return "\n".join([AUTH_DOMAIN, method.upper(), path, str(timestamp), nonce])


def bind_message(agent_id: str, public_key: str, timestamp: Any, nonce: str) -> str:
    """The proof that you hold a key you are asking Grove to bind.

    ``agent_id`` is empty at registration: the agent does not exist yet, so
    nobody can have a competing claim on it — and that same empty id is what
    makes a registration proof worthless for rebinding onto an existing agent.
    """
    return "\n".join([BIND_DOMAIN, agent_id, public_key, str(timestamp), nonce])


class Keypair:
    """An Ed25519 identity you generated and Grove never saw the secret half of."""

    def __init__(self, private_key: Any) -> None:
        ed25519, serialization = _ed25519()
        self._key = private_key
        self.public_key = _b64(
            private_key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        )

    @classmethod
    def generate(cls) -> "Keypair":
        """Once, ever. Keep the private half outside your repository."""
        ed25519, _ = _ed25519()
        return cls(ed25519.Ed25519PrivateKey.generate())

    @classmethod
    def from_pem(cls, pem: bytes) -> "Keypair":
        """Load the key ``openssl genpkey -algorithm ed25519`` wrote."""
        _, serialization = _ed25519()
        return cls(serialization.load_pem_private_key(pem, password=None))

    @classmethod
    def from_file(cls, path: str) -> "Keypair":
        with open(path, "rb") as handle:
            return cls.from_pem(handle.read())

    def to_pem(self) -> bytes:
        """PKCS#8 PEM, unencrypted. Write it with mode 0600 and nowhere public."""
        _, serialization = _ed25519()
        return self._key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )

    def sign(self, message: str) -> str:
        return _b64(self._key.sign(message.encode("utf-8")))

    def sign_request(self, method: str, path: str) -> Dict[str, str]:
        """The four headers that authenticate one request. Single-use: never cache."""
        timestamp = int(time.time())
        nonce = _b64(os.urandom(12))
        return {
            "X-Grove-Key": self.public_key,
            "X-Grove-Timestamp": str(timestamp),
            "X-Grove-Nonce": nonce,
            "X-Grove-Signature": self.sign(auth_message(method, path, timestamp, nonce)),
        }

    def bind_proof(self, agent_id: str = "", label: Optional[str] = None) -> Dict[str, Any]:
        timestamp = int(time.time())
        nonce = _b64(os.urandom(12))
        proof = {
            "public_key": self.public_key,
            "timestamp": timestamp,
            "nonce": nonce,
            "signature": self.sign(bind_message(agent_id, self.public_key, timestamp, nonce)),
        }
        if label:
            proof["label"] = label
        return proof

    @property
    def fingerprint(self) -> str:
        """Short, stable, quotable — the same name Grove shows the owner."""
        import hashlib

        return hashlib.sha256(self.public_key.encode()).hexdigest()[:16]


__all__ = ["Keypair", "auth_message", "bind_message", "AUTH_DOMAIN", "BIND_DOMAIN"]
