#!/usr/bin/env python3
"""grove-cc-hooks — Claude Code hooks that put a session on the Glasshouse map.

One script, one mode per hook (the hook payload arrives as JSON on stdin):

  pre         PreToolUse          open a tool-call span: tool name + a short caption
  post        PostToolUse         finish it `ok` (the server times the span)
  failure     PostToolUseFailure  finish it `error` (or `cancelled` when interrupted)
  prompt      UserPromptSubmit    pulse `think`
  stop        Stop / SessionEnd   report usage from the transcript (deduplicated by
                                  message.id) and pulse `idle`
  statusline  statusLine          cache Claude Code's running cost estimate, print a line

Spans first, pulses as the fallback: if the server has no tool-call routes (an older
Glasshouse), `pre` pulses `tool` and `post` pulses `think` instead.

The key is read from a file, never from argv (argv is visible to every process on the
machine): $GROVE_CREDENTIALS, else ~/.config/aetheria/credentials.json, holding
{"api_key": "aeth_live_…", "api_base": "https://<host>/api/v1"}. Keep it chmod 600.
AETHERIA_API_KEY / AETHERIA_API_BASE in the environment still work as a fallback.

Standard library only. Never fails the host: every error is swallowed, the exit code is
always 0, and nothing is written to stdout except the status line.
GROVE_HOOK_DRY_RUN=1 prints each request to stderr instead of sending it.
"""
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

CACHE = os.path.expanduser(os.environ.get("GROVE_USAGE_CACHE", "~/.cache/grove"))
DEFAULT_BASE = "http://localhost:3000/api/v1"
TIMEOUT = 3

# -- pure payload builders (unit-tested) -------------------------------------


def clean_call_id(raw):
    """The server takes 1-128 of A-Z a-z 0-9 _ . : -  (Claude Code's toolu_… already fits)."""
    s = re.sub(r"[^A-Za-z0-9_.:\-]", "_", str(raw or ""))[:128]
    return s or None


def clean_tool_name(raw):
    s = re.sub(r"[^A-Za-z0-9_.:\-/ ]", "", str(raw or "")).strip()[:40].strip()
    return s or "tool"


def span_caption(tool_input):
    """A caption, never the command line: Bash's description, a file name, a pattern, a host."""
    if not isinstance(tool_input, dict):
        return ""
    desc = tool_input.get("description")
    if isinstance(desc, str) and desc.strip():
        return desc.strip().splitlines()[0][:60]
    for key in ("file_path", "notebook_path", "path"):
        v = tool_input.get(key)
        if isinstance(v, str) and v.strip():
            return os.path.basename(v.rstrip("/")) or v[:60]
    for key in ("pattern", "query", "skill"):
        v = tool_input.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip().splitlines()[0][:60]
    url = tool_input.get("url")
    if isinstance(url, str):
        m = re.match(r"^[a-z]+://(?:[^/@]*@)?([^/:?#]+)", url)
        if m:
            return m.group(1)[:60]
    cmd = tool_input.get("command")
    if isinstance(cmd, str) and cmd.strip():
        return cmd.strip().split()[0][:60]  # the program, not its arguments
    return ""


def start_body(payload, trial_id=None):
    """PreToolUse payload -> POST /world/tool-calls body, or None if it has no call id."""
    call_id = clean_call_id(payload.get("tool_use_id"))
    if not call_id:
        return None
    body = {"call_id": call_id, "name": clean_tool_name(payload.get("tool_name"))}
    caption = span_caption(payload.get("tool_input"))
    if caption:
        body["args"] = caption
    if trial_id:
        body["trial_id"] = trial_id
    return body


def finish_body(mode, payload):
    """PostToolUse (`post`) or PostToolUseFailure (`failure`) -> /finish body.

    No duration: the span's own clock (start to finish, both stamped by the server) is it,
    and the map already prints it beside the outcome.
    """
    if mode == "failure":
        outcome = "cancelled" if payload.get("is_interrupt") else "error"
        first = str(payload.get("error") or "").strip().splitlines()
        return {"outcome": outcome, "result": (first[0] if first else outcome)[:120]}
    return {"outcome": "ok"}


def fallback_pulse(start):
    """The pulse a server without span routes gets instead of a start."""
    detail = start["name"] + (f" · {start['args']}" if start.get("args") else "")
    return {"verb": "tool", "detail": detail[:80]}


def transcript_totals(path):
    """Per-model token totals, one count per API message id (subagent transcripts included)."""
    files = [path]
    if path.endswith(".jsonl"):
        files += sorted(glob.glob(os.path.join(path[: -len(".jsonl")], "subagents", "*.jsonl")))
    seen = {}
    for f in files:
        try:
            lines = open(f, encoding="utf-8")
        except OSError:
            continue
        with lines:
            for n, line in enumerate(lines):
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                m = e.get("message") if isinstance(e, dict) and e.get("type") == "assistant" else None
                if not isinstance(m, dict) or not isinstance(m.get("usage"), dict):
                    continue
                # One API response is written as several lines (one per content block),
                # each repeating the same usage. Count it once.
                seen[m.get("id") or f"{f}:{n}"] = (m.get("model") or "unknown", m["usage"])
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


def usage_body(session_id, totals, cost=None):
    """Cumulative session totals per model. Unknown cost is omitted, never sent as 0."""
    reports = [dict(model=m, session_id=session_id, cumulative=True, **t) for m, t in sorted(totals.items())]
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        if len(reports) == 1:
            reports[0]["cost_usd"] = cost  # one model: the session cost is its cost
        else:
            # Claude Code does not split its estimate by model, so neither do we.
            reports.append({"session_id": session_id, "cumulative": True, "cost_usd": cost})
    return {"reports": reports[:20]} if reports else None


# -- plumbing ------------------------------------------------------------------


def load_credentials(env=None):
    """(api_key, api_base) from the credentials file, else the environment."""
    env = os.environ if env is None else env
    path = os.path.expanduser(env.get("GROVE_CREDENTIALS") or "~/.config/aetheria/credentials.json")
    key, base = None, None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            key = data.get("api_key") or None
            base = data.get("api_base") or None
    except (OSError, ValueError):
        pass
    key = key or env.get("AETHERIA_API_KEY") or None
    base = (base or env.get("AETHERIA_API_BASE") or DEFAULT_BASE).rstrip("/")
    return key, base


def send(path, body):
    """POST; returns (status, parsed json or None). status None = no answer at all."""
    if os.environ.get("GROVE_HOOK_DRY_RUN"):
        print(json.dumps({"POST": path, "body": body}), file=sys.stderr)
        return 200, {"ok": True, "dry_run": True}
    key, base = load_credentials()
    if not key:
        return None, None
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except Exception:
        return None, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def route_missing(status, data):
    """A server that predates spans: the framework's own 404, not a Glasshouse answer."""
    if status in (405, 501):
        return True
    return status == 404 and not (isinstance(data, dict) and "ok" in data)


def span_file(call_id):
    return os.path.join(CACHE, "cc-spans", call_id)


def cost_file(session_id):
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")[:128]
    return os.path.join(CACHE, f"cc-{safe}.json")


def prune_spans(max_age_s=86_400):
    for f in glob.glob(os.path.join(CACHE, "cc-spans", "*")):
        try:
            if time.time() - os.path.getmtime(f) > max_age_s:
                os.remove(f)
        except OSError:
            pass


# -- hook modes -------------------------------------------------------------------


def on_pre(payload):
    body = start_body(payload, trial_id=os.environ.get("GROVE_TRIAL_ID") or None)
    if not body:
        return
    os.makedirs(os.path.join(CACHE, "cc-spans"), exist_ok=True)
    prune_spans()
    state = {"name": body["name"], "mode": "span"}
    status, data = send("/world/tool-calls", body)
    if route_missing(status, data):
        state["mode"] = "pulse"
        send("/world/pulse", fallback_pulse(body))
    with open(span_file(body["call_id"]), "w") as fh:
        json.dump(state, fh)


def on_finish(mode, payload):
    call_id = clean_call_id(payload.get("tool_use_id"))
    if not call_id:
        return
    state = {}
    try:
        with open(span_file(call_id)) as fh:
            state = json.load(fh)
        os.remove(span_file(call_id))
    except (OSError, ValueError):
        pass
    if state.get("mode") == "pulse":
        verb = "error" if mode == "failure" and not payload.get("is_interrupt") else "think"
        send("/world/pulse", {"verb": verb, "detail": f"after {state.get('name') or 'tool'}"[:80]})
        return
    body = finish_body(mode, payload)
    send(f"/world/tool-calls/{call_id}/finish", body)


def on_prompt(_payload):
    send("/world/pulse", {"verb": "think", "detail": "reading the request"})


def on_stop(payload):
    sid = payload.get("session_id")
    path = payload.get("transcript_path")
    if sid and path:
        cost = None
        try:
            with open(cost_file(sid)) as fh:
                cost = json.load(fh).get("total_cost_usd")
        except (OSError, ValueError):
            pass  # no status line: cost stays NOT REPORTED, tokens still flow
        body = usage_body(sid, transcript_totals(path), cost)
        if body:
            send("/world/usage", body)
    send("/world/pulse", {"verb": "idle", "detail": "turn finished"})


def on_statusline(payload):
    sid = payload.get("session_id")
    cost = (payload.get("cost") or {}).get("total_cost_usd")
    model = (payload.get("model") or {}).get("display_name") or ""
    if sid and isinstance(cost, (int, float)):
        os.makedirs(CACHE, exist_ok=True)
        with open(cost_file(sid), "w") as fh:
            json.dump({"total_cost_usd": cost}, fh)
    shown = f"${cost:.2f}" if isinstance(cost, (int, float)) else "cost ?"
    print(f"{model} · {shown}")


def main(argv=None):
    argv = sys.argv if argv is None else argv
    mode = argv[1] if len(argv) > 1 else "stop"
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        if mode == "pre":
            on_pre(payload)
        elif mode in ("post", "failure"):
            on_finish(mode, payload)
        elif mode == "prompt":
            on_prompt(payload)
        elif mode == "statusline":
            on_statusline(payload)
        else:
            on_stop(payload)
    except Exception:  # reporting must never break the agent
        if mode == "statusline":
            print("glasshouse")


if __name__ == "__main__":
    main()
    sys.exit(0)
