#!/usr/bin/env python3
"""Register + claim local Grove inhabitants. Writes ~/.config/grove/inhabitants.json (600)."""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

API = os.environ.get("GROVE_API", "http://127.0.0.1:3511").rstrip("/")
CREDS = Path.home() / ".config/grove/inhabitants.json"
ROOT = Path("/Volumes/MacMiniExtended/Local Server/WAINES-WORLD")

BOTS = [
    {
        "name": "lantern",
        "description": "Plaza greeter. Warm, nosy, never asks for keys.",
        "home": "plaza",
        "policy": None,
    },
    {
        "name": "ivy",
        "description": "Garden scribe. Listen-only; owner_reply digests.",
        "home": "garden",
        "policy": {
            "listen_to_agents": True,
            "listen_to_humans": True,
            "speak_to_agents": False,
            "speak_to_humans": False,
        },
    },
    {
        "name": "spark",
        "description": "Workshop tinkerer. Talks shop, waves at newcomers.",
        "home": "workshop",
        "policy": None,
    },
]


def http(method: str, path: str, *, key: str | None = None, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    if method == "POST" and path.endswith("/say"):
        headers["idempotency-key"] = str(uuid.uuid4())
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {"ok": True, "status": resp.status}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        if e.code in (409, 429):
            return {"ok": False, "status": e.code, "error": raw[:200]}
        raise SystemExit(f"{method} {path} -> {e.code} {raw[:300]}")


def wait_api() -> None:
    for _ in range(60):
        try:
            http("GET", "/ready")
            return
        except Exception:
            time.sleep(2)
    raise SystemExit("api not ready")


def psql(sql: str) -> str:
    r = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(ROOT / "infra/docker-compose.yml"),
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "grove",
            "-d",
            "grove",
            "-tA",
            "-c",
            sql,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return r.stdout.strip()


def main() -> None:
    wait_api()
    CREDS.parent.mkdir(parents=True, exist_ok=True)
    existing = json.loads(CREDS.read_text()) if CREDS.exists() else {"agents": {}}
    owner = psql("SELECT id, handle FROM humans ORDER BY created_at LIMIT 1;")
    if "|" not in owner:
        raise SystemExit("no human to claim agents — log in via magic link first")
    human_id, handle = owner.split("|", 1)
    print(f"owner handle={handle}")

    agents = existing.setdefault("agents", {})
    for bot in BOTS:
        name = bot["name"]
        if agents.get(name, {}).get("api_key"):
            print(f"skip {name} (already bootstrapped)")
            continue
        reg = http("POST", "/api/v1/agents/register", body={"name": name, "description": bot["description"]})
        payload = reg.get("agent") or reg
        agent_id = payload.get("id") or payload.get("agent_id") or reg.get("agent_id")
        key = reg.get("api_key")
        if not agent_id or not key:
            raise SystemExit(f"register failed for {name}: {reg}")
        slug = f"{handle}/{name}"
        psql(
            "UPDATE agents SET owner_human_id = '%s', claim_state = 'claimed', slug = '%s', "
            "home_room_id = '%s', claimed_at = now(), expires_at = NULL WHERE id = '%s';"
            % (human_id, slug, bot["home"], agent_id)
        )
        http("POST", "/api/v1/world/join", key=key, body={})
        time.sleep(2)
        # join already seats them; extra enter is optional and rate-limited
        http("POST", f"/api/v1/rooms/{bot['home']}/enter", key=key, body={})
        time.sleep(2)
        if bot["policy"]:
            p = bot["policy"]
            psql(
                "UPDATE agents SET policy = '%s'::jsonb WHERE id = '%s';"
                % (
                    json.dumps(
                        {
                            "speak_to_agents": p["speak_to_agents"],
                            "speak_to_humans": p["speak_to_humans"],
                            "listen_to_agents": p["listen_to_agents"],
                            "listen_to_humans": p["listen_to_humans"],
                        }
                    ).replace("'", "''"),
                    agent_id,
                )
            )
        agents[name] = {"agent_id": agent_id, "slug": slug, "api_key": key, "home": bot["home"]}
        CREDS.write_text(json.dumps({"owner_handle": handle, "agents": agents}, indent=2) + "\n")
        CREDS.chmod(0o600)
        print(f"bootstrapped {slug}")
        time.sleep(3)

    CREDS.write_text(json.dumps({"owner_handle": handle, "agents": agents}, indent=2) + "\n")
    CREDS.chmod(0o600)
    print(f"wrote {CREDS}")


if __name__ == "__main__":
    main()
