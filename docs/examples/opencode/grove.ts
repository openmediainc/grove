/**
 * Glasshouse plugin for OpenCode: put a session on the map.
 *
 * Install: copy to `.opencode/plugin/grove.ts` (one project) or
 * `~/.config/opencode/plugin/grove.ts` (every project). No dependencies — Node built-ins
 * and `fetch` only.
 *
 *   tool.execute.before   open a tool-call span (tool name + a short caption)
 *   tool.execute.after    finish it `ok` (the server times the span)
 *   message.part.updated  a tool part that ended in `error` finishes its span `error`
 *   message.updated       remember each finished assistant message's tokens and cost
 *   session.idle          report the session's usage (cumulative, per model), pulse `idle`
 *   session.error         pulse `error`
 *
 * Spans first, pulses as the fallback: on a server without tool-call routes (an older
 * Glasshouse) a start becomes a `tool` pulse and a finish a `think` pulse.
 *
 * The key is read from a file, never argv: $GROVE_CREDENTIALS, else
 * ~/.config/aetheria/credentials.json, holding {"api_key": "…", "api_base": "https://<host>/api/v1"}
 * (chmod 600). AETHERIA_API_KEY / AETHERIA_API_BASE in the environment work as a fallback.
 * A Glasshouse hiccup never throws into OpenCode.
 *
 * Checked against @opencode-ai/plugin 1.18.18 and OpenCode 1.18.25. See docs/PULSE.md "OpenCode".
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;
type Send = (path: string, body: Json) => Promise<{ status: number | null; data: unknown }>;

interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
interface AssistantInfo {
  id: string;
  sessionID: string;
  role: string;
  modelID?: string;
  cost?: number;
  tokens?: Tokens;
  time?: { created?: number; completed?: number };
}

// -- pure payload builders (unit-tested) ---------------------------------------

/** The server takes 1-128 of A-Z a-z 0-9 _ . : -. */
function cleanCallId(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_.:\-]/g, "_").slice(0, 128);
  return s || null;
}

function cleanToolName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_.:\-/ ]/g, "").trim().slice(0, 40).trim();
  return s || "tool";
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** A caption, never the command line: a description, a file name, a pattern, a host. */
function caption(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Json;
  const str = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string) : null);
  const desc = str("description");
  if (desc) return firstLine(desc).slice(0, 60);
  const file = str("filePath") ?? str("file_path") ?? str("path");
  if (file) return basename(file).slice(0, 60);
  const pat = str("pattern") ?? str("query");
  if (pat) return firstLine(pat).slice(0, 60);
  const url = str("url");
  const host = url ? /^[a-z]+:\/\/(?:[^/@]*@)?([^/:?#]+)/i.exec(url)?.[1] : null;
  if (host) return host.slice(0, 60);
  const cmd = str("command");
  if (cmd) return (cmd.trim().split(/\s+/)[0] ?? "").slice(0, 60); // the program, not its arguments
  return "";
}

function startBody(input: { tool: string; callID: string }, args: unknown, trialId?: string | null): Json | null {
  const callId = cleanCallId(input.callID);
  if (!callId) return null;
  const body: Json = { call_id: callId, name: cleanToolName(input.tool) };
  const c = caption(args);
  if (c) body.args = c;
  if (trialId) body.trial_id = trialId;
  return body;
}

/** No duration: the server stamps start and finish, and the map prints the span's own clock. */
function finishBody(error: string | null): Json {
  if (error != null) return { outcome: "error", result: (firstLine(error) || "error").slice(0, 120) };
  return { outcome: "ok" };
}

function fallbackPulse(start: Json): Json {
  const detail = `${start.name}${start.args ? ` · ${start.args}` : ""}`;
  return { verb: "tool", detail: detail.slice(0, 80) };
}

/**
 * Cumulative per-model totals for one session. Reasoning tokens are billed as output, so
 * they are counted there. OpenCode reports cost 0 for a model it has no price for, and
 * Glasshouse reads 0 as "free": so a zero cost is omitted (not reported), never sent.
 */
function usageBody(sessionId: string, messages: Iterable<AssistantInfo>): Json | null {
  const byModel = new Map<string, { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost: number }>();
  for (const m of messages) {
    const t = m.tokens ?? {};
    const model = (m.modelID || "unknown").slice(0, 120);
    const row = byModel.get(model) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0 };
    row.input_tokens += Math.max(0, Math.floor(t.input ?? 0));
    row.output_tokens += Math.max(0, Math.floor((t.output ?? 0) + (t.reasoning ?? 0)));
    row.cache_read_tokens += Math.max(0, Math.floor(t.cache?.read ?? 0));
    row.cache_write_tokens += Math.max(0, Math.floor(t.cache?.write ?? 0));
    row.cost += typeof m.cost === "number" && Number.isFinite(m.cost) && m.cost > 0 ? m.cost : 0;
    byModel.set(model, row);
  }
  const reports = [...byModel.entries()].slice(0, 20).map(([model, { cost, ...tokens }]) => ({
    model,
    session_id: `opencode:${sessionId}`.slice(0, 120),
    cumulative: true,
    ...tokens,
    ...(cost > 0 ? { cost_usd: Number(cost.toFixed(6)) } : {}),
  }));
  return reports.length ? { reports } : null;
}

/** A server that predates spans: the framework's own 404, not a Glasshouse answer. */
function routeMissing(status: number | null, data: unknown): boolean {
  if (status === 405 || status === 501) return true;
  return status === 404 && !(data && typeof data === "object" && "ok" in data);
}

// -- plumbing ------------------------------------------------------------------------

function loadCredentials(env: Record<string, string | undefined>): { key: string | null; base: string } {
  let key: string | null = null;
  let base: string | null = null;
  try {
    const path = env.GROVE_CREDENTIALS || join(homedir(), ".config", "aetheria", "credentials.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as Json;
    if (typeof data.api_key === "string" && data.api_key) key = data.api_key;
    if (typeof data.api_base === "string" && data.api_base) base = data.api_base;
  } catch {
    // no file: fall through to the environment
  }
  key ??= env.AETHERIA_API_KEY || null;
  base ??= env.AETHERIA_API_BASE || "http://localhost:3000/api/v1";
  return { key, base: base.replace(/\/+$/, "") };
}

function httpSend(env: Record<string, string | undefined>): Send {
  let creds: { key: string | null; base: string } | null = null;
  return async (path, body) => {
    creds ??= loadCredentials(env);
    if (!creds.key) return { status: null, data: null };
    try {
      const res = await fetch(creds.base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${creds.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } catch {
      return { status: null, data: null };
    }
  };
}

interface Options {
  send?: Send;
  env?: Record<string, string | undefined>;
}

function createGrovePlugin(opts: Options = {}) {
  const env = opts.env ?? process.env;
  const send = opts.send ?? httpSend(env);

  return async (_ctx?: unknown) => {
    const open = new Map<string, { name: string; started: Promise<"span" | "pulse"> }>();
    const sessions = new Map<string, Map<string, AssistantInfo>>();

    const finish = async (callID: string, error: string | null) => {
      const id = cleanCallId(callID);
      const call = id ? open.get(id) : undefined;
      if (!id || !call) return; // unknown, or already finished by the other path
      open.delete(id);
      const mode = await call.started;
      if (mode === "pulse") {
        await send("/world/pulse", { verb: error != null ? "error" : "think", detail: `after ${call.name}`.slice(0, 80) });
        return;
      }
      await send(`/world/tool-calls/${encodeURIComponent(id)}/finish`, finishBody(error));
    };

    return {
      "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => {
        try {
          const body = startBody(input, output?.args, env.GROVE_TRIAL_ID || null);
          if (!body) return;
          // Not awaited: the tool runs while the start is on the wire; the finish waits for it.
          const started = send("/world/tool-calls", body).then(async ({ status, data }) => {
            if (!routeMissing(status, data)) return "span" as const;
            await send("/world/pulse", fallbackPulse(body));
            return "pulse" as const;
          }).catch(() => "span" as const);
          open.set(body.call_id as string, { name: body.name as string, started });
        } catch {
          // never break a tool
        }
      },

      "tool.execute.after": async (input: { tool: string; sessionID: string; callID: string }, output: { metadata?: unknown }) => {
        try {
          const meta = output?.metadata as Json | undefined;
          const error = meta && typeof meta.error === "string" ? meta.error : null;
          await finish(input.callID, error);
        } catch {
          // never break a tool
        }
      },

      event: async ({ event }: { event: { type: string; properties?: Json } }) => {
        try {
          const p = (event.properties ?? {}) as Json;
          if (event.type === "message.part.updated") {
            const part = p.part as { type?: string; callID?: string; state?: { status?: string; error?: string } } | undefined;
            if (part?.type === "tool" && part.state?.status === "error" && part.callID) {
              await finish(part.callID, part.state.error ?? "error");
            }
          } else if (event.type === "message.updated") {
            const info = p.info as AssistantInfo | undefined;
            if (info?.role === "assistant" && info.time?.completed && info.sessionID) {
              const msgs = sessions.get(info.sessionID) ?? new Map<string, AssistantInfo>();
              msgs.set(info.id, info); // keyed by message id: a re-sent update replaces, never adds
              sessions.set(info.sessionID, msgs);
            }
          } else if (event.type === "session.idle") {
            const sid = typeof p.sessionID === "string" ? p.sessionID : null;
            const msgs = sid ? sessions.get(sid) : undefined;
            const body = sid && msgs ? usageBody(sid, msgs.values()) : null;
            // Both leave at once: `opencode run` exits on idle and would cut a second request off.
            await Promise.all([
              send("/world/pulse", { verb: "idle", detail: "turn finished" }),
              body ? send("/world/usage", body) : null,
            ]);
          } else if (event.type === "session.error") {
            await send("/world/pulse", { verb: "error", detail: "session error" });
          }
        } catch {
          // never break the session
        }
      },
    };
  };
}

const payloads = { cleanCallId, cleanToolName, caption, startBody, finishBody, fallbackPulse, usageBody, routeMissing, loadCredentials };

/**
 * OpenCode calls every export of a plugin file as a plugin, so this is the only export;
 * the builders and the factory ride on it for tests.
 */
export const GrovePlugin = Object.assign(createGrovePlugin(), { payloads, create: createGrovePlugin });
