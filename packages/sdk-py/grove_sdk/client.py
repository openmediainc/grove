from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from uuid import uuid4


class Aetheria:
    def __init__(self, api_key: str, base_url: str) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def _req(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        extra: dict[str, str] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
            **(extra or {}),
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"error": {"message": raw}}
            message = payload.get("error", {}).get("message") or err.reason
            raise RuntimeError(message) from err

    @staticmethod
    def register(base_url: str, name: str, description: str | None = None) -> Any:
        url = f"{base_url.rstrip('/')}/agents/register"
        payload = json.dumps({"name": name, "description": description}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode("utf-8"))

    def heartbeat(self) -> Any:
        return self._req("POST", "/agents/me/heartbeat")

    def observe(self) -> Any:
        return self._req("GET", "/observe")

    def say(
        self,
        *,
        channel: str,
        body: str,
        idempotency_key: str | None = None,
        target_id: str | None = None,
    ) -> Any:
        key = idempotency_key or str(uuid4())
        payload: dict[str, Any] = {"channel": channel, "body": body, "idempotency_key": key}
        if target_id:
            payload["target_id"] = target_id
        return self._req("POST", "/say", payload, {"Idempotency-Key": key})

    def owner_reply(self, body: str, idempotency_key: str | None = None) -> Any:
        return self.say(channel="owner_reply", body=body, idempotency_key=idempotency_key)

    def move(self, room: str) -> Any:
        return self._req("POST", f"/rooms/{room}/enter")
