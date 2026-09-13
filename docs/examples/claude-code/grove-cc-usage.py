#!/usr/bin/env python3
"""grove-cc-usage — report a Claude Code session's usage to Grove.

Two modes, because Claude Code exposes the two halves in two places:

  statusline  Claude Code pipes the status-line JSON on stdin. It carries
              cost.total_cost_usd (Claude Code's own running estimate for the
              session) and model.id — but no running token totals. We cache the
              cost per session and print a one-line status.

  stop        Run from the Stop (and SessionEnd) hook. The hook payload carries
              session_id and transcript_path — but no cost and no tokens. Tokens
              come from the transcript JSONL (message.usage per API call,
              de-duplicated by message.id, subagent transcripts included). Cost
              comes from the statusline cache, if the statusline ever ran.

Everything is sent as CUMULATIVE session totals, so Grove counts only the
increase and a repeated or late hook never double-counts.

Never fails the host: every error is swallowed and the exit code is 0.
Needs AETHERIA_API_KEY; AETHERIA_API_BASE defaults to http://localhost:3000/api/v1.
GROVE_USAGE_DRY_RUN=1 prints the request instead of sending it.
"""
import glob
import json
import os
import sys
import urllib.request

CACHE = os.path.expanduser(os.environ.get("GROVE_USAGE_CACHE", "~/.cache/grove"))


def cache_file(session_id):
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")[:128]
    return os.path.join(CACHE, f"cc-{safe}.json")


def statusline(payload):
    sid = payload.get("session_id")
    cost = (payload.get("cost") or {}).get("total_cost_usd")
    model = (payload.get("model") or {}).get("display_name") or ""
    if sid and isinstance(cost, (int, float)):
        os.makedirs(CACHE, exist_ok=True)
        with open(cache_file(sid), "w") as fh:
            json.dump({"total_cost_usd": cost}, fh)
    shown = f"${cost:.2f}" if isinstance(cost, (int, float)) else "cost ?"
    print(f"{model} · {shown}")


def transcript_totals(path):
    """Per-model token totals, one count per API message id."""
    files = [path] + sorted(glob.glob(os.path.join(path[: -len(".jsonl")], "subagents", "*.jsonl")))
    seen = {}
    for f in files:
        try:
            lines = open(f, encoding="utf-8")
        except OSError:
            continue
        with lines:
            for line in lines:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                m = e.get("message") if e.get("type") == "assistant" else None
                if not isinstance(m, dict) or not isinstance(m.get("usage"), dict):
                    continue
                # One API response is written as several lines (one per content
                # block), each repeating the same usage. Count it once.
                seen[m.get("id") or id(e)] = (m.get("model") or "unknown", m["usage"])
    totals = {}
    for model, u in seen.values():
        if model == "<synthetic>":
            continue
        t = totals.setdefault(model, {"input_tokens": 0, "output_tokens": 0,
                                      "cache_read_tokens": 0, "cache_write_tokens": 0})
        t["input_tokens"] += int(u.get("input_tokens") or 0)
        t["output_tokens"] += int(u.get("output_tokens") or 0)
        t["cache_read_tokens"] += int(u.get("cache_read_input_tokens") or 0)
        t["cache_write_tokens"] += int(u.get("cache_creation_input_tokens") or 0)
    return totals


def stop(payload):
    sid = payload.get("session_id")
    path = payload.get("transcript_path")
    if not sid or not path:
        return
    totals = transcript_totals(path)
    cost = None
    try:
        with open(cache_file(sid)) as fh:
            cost = json.load(fh).get("total_cost_usd")
    except (OSError, ValueError):
        pass  # no statusline: cost stays NOT REPORTED, tokens still flow
    reports = [dict(model=m, session_id=sid, cumulative=True, **t) for m, t in totals.items()]
    if isinstance(cost, (int, float)):
        if len(reports) == 1:
            reports[0]["cost_usd"] = cost  # one model: the session cost is its cost
        else:
            # Claude Code does not split its estimate by model, so neither do we.
            reports.append({"session_id": sid, "cumulative": True, "cost_usd": cost})
    if not reports:
        return
    body = json.dumps({"reports": reports[:20]}).encode()
    if os.environ.get("GROVE_USAGE_DRY_RUN"):
        print(body.decode())
        return
    key = os.environ.get("AETHERIA_API_KEY")
    if not key:
        return
    base = os.environ.get("AETHERIA_API_BASE", "http://localhost:3000/api/v1").rstrip("/")
    req = urllib.request.Request(f"{base}/world/usage", data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=3).read()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "stop"
    try:
        payload = json.load(sys.stdin)
        (statusline if mode == "statusline" else stop)(payload)
    except Exception:  # accounting must never break the agent
        if mode == "statusline":
            print("grove")


if __name__ == "__main__":
    main()
