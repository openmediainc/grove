import type { FastifyReply, FastifyRequest } from "fastify";
import { GroveError, QuotaService } from "@grove/domain";
import { capabilityWire, HTTP_STATUS_FOR_CODE, toSnake } from "@grove/protocol";

// ---------------------------------------------------------------------------
// Rate-limit headers.
//
// THE ONE RULE: no limit is written down twice. Every number below is derived
// at runtime from packages/domain/src/services/quota.ts by *running* it, so a
// change there changes these headers, /rate-limits.json, /skill.json and the
// rate-limit table inside the served /skill.md with nothing to remember.
//
// How the derivation works: QuotaService talks to a RateLimiter interface, so we
// hand it an instrumented in-memory one and charge each limiter in a loop until
// it refuses. The count at which it refused IS the limit; the windowSec passed
// to incr() IS the window; the ms passed to setPx() IS the minimum gap. Buckets
// with two windows (register: 3/hour AND 10/day) are found by freezing the
// window we already learned and going round again.
//
// What is NOT derived is which route charges which limiter. That is routing
// knowledge, it lives in ROUTE_BUCKETS below, and it holds no numbers.
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  /** Seconds the window covers. */
  windowSeconds: number;
  /** Calls allowed inside that window. */
  limit: number;
}

export interface QuotaBucket {
  name: string;
  windows: QuotaWindow[];
  /** Minimum spacing between two calls, in seconds. 0 when the bucket has none. */
  gapSeconds: number;
  /** Human note for the generated docs table. */
  charged: string;
}

export interface RateLimitTable {
  buckets: Record<string, QuotaBucket>;
  /** Limiters quota.ts defines but nothing charges. Published so nobody paces against a ghost. */
  unenforced: string[];
}

/**
 * A RateLimiter that records what it is asked to do instead of enforcing it.
 * Structurally compatible with @grove/domain's RateLimiter (the interface type
 * is not exported; the shape is the contract).
 */
class ProbeLimiter {
  counts = new Map<string, number>();
  windows = new Map<string, number>();
  gaps = new Map<string, number>();
  /** Keys already attributed to a window; reset after every charge so the next window can be found. */
  frozen = new Set<string>();
  /** The last key incremented — on a refusal, this is the limiter that refused. */
  lastKey: string | null = null;
  /** Gap keys are invisible while probing windows, so a cooldown cannot mask a window. */
  gapsVisible = false;

  async incr(key: string, windowSec: number): Promise<number> {
    this.windows.set(key, windowSec);
    this.lastKey = key;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }

  async get(key: string): Promise<number> {
    return this.counts.get(key) ?? 0;
  }

  async setPx(key: string, _value: string, ms: number): Promise<void> {
    this.gaps.set(key, ms);
  }

  async ttlMs(key: string): Promise<number> {
    return this.gaps.get(key) ?? -2;
  }

  async exists(key: string): Promise<boolean> {
    return this.gapsVisible && this.gaps.has(key);
  }

  release(): void {
    for (const key of this.frozen) this.counts.delete(key);
  }
}

const PROBE_ACTOR = "probe";
const PROBE_ROOM = "probe-room";
/** Every limit in quota.ts is far below this; it only stops a runaway loop. */
const PROBE_CEILING = 500;

async function probe(charge: (quota: QuotaService, limiter: ProbeLimiter) => Promise<unknown>): Promise<{
  windows: QuotaWindow[];
  gapSeconds: number;
}> {
  const limiter = new ProbeLimiter();
  const quota = new QuotaService(limiter as never);
  const windows: QuotaWindow[] = [];
  // Up to four independent windows on one bucket; nothing has more than two.
  for (let pass = 0; pass < 4; pass += 1) {
    let refusedKey: string | null = null;
    for (let i = 0; i < PROBE_CEILING; i += 1) {
      limiter.lastKey = null;
      try {
        await charge(quota, limiter);
        limiter.release();
      } catch {
        refusedKey = limiter.lastKey;
        break;
      }
    }
    if (!refusedKey) break;
    const count = limiter.counts.get(refusedKey) ?? 0;
    const windowSeconds = limiter.windows.get(refusedKey) ?? 0;
    windows.push({ windowSeconds, limit: Math.max(0, count - 1) });
    limiter.frozen.add(refusedKey);
    limiter.counts.delete(refusedKey);
  }
  // A gap is a cooldown key written with setPx; the ms it was written with is the gap.
  let gapMs = 0;
  for (const ms of limiter.gaps.values()) gapMs = Math.max(gapMs, ms);
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return { windows, gapSeconds: gapMs / 1000 };
}

/** A cooldown-only limiter (pulse): charge once, then make the gap key visible and charge again. */
async function probeGapOnly(charge: (quota: QuotaService) => Promise<unknown>): Promise<number> {
  const limiter = new ProbeLimiter();
  const quota = new QuotaService(limiter as never);
  await charge(quota);
  let gapMs = 0;
  for (const ms of limiter.gaps.values()) gapMs = Math.max(gapMs, ms);
  return gapMs / 1000;
}

async function deriveTable(): Promise<RateLimitTable> {
  // room_say and write never throw from consumeSay — the speech kernel refuses
  // them from a QuotaSnapshot instead. An untouched limiter therefore reports
  // the full allowance: remaining == limit.
  const freshQuota = new QuotaService(new ProbeLimiter() as never);
  const established = await freshQuota.snapshotForSay(PROBE_ACTOR, PROBE_ROOM, false);
  const firstDay = await freshQuota.snapshotForSay(PROBE_ACTOR, PROBE_ROOM, true);

  const sayShape = await probe((quota) => quota.consumeSay(PROBE_ACTOR, PROBE_ROOM, false));
  const sayShapeNew = await probe((quota) => quota.consumeSay(PROBE_ACTOR, PROBE_ROOM, true));
  const sayWindow = sayShape.windows[0]?.windowSeconds ?? 60;

  const write = await probe((quota) => quota.consumeWrite(PROBE_ACTOR, false));
  const writeNew = await probe((quota) => quota.consumeWrite(PROBE_ACTOR, true));
  const read = await probe((quota) => quota.consumeRead(PROBE_ACTOR));
  const move = await probe((quota) => quota.consumeMove(PROBE_ACTOR));
  const whisper = await probe((quota) => quota.consumeWhisper(PROBE_ACTOR, false));
  const whisperNew = await probe((quota) => quota.consumeWhisper(PROBE_ACTOR, true));
  const register = await probe((quota) => quota.consumeRegister(PROBE_ACTOR));
  const enter = await probe((quota) => quota.consumeEnter(PROBE_ACTOR));
  const joinRequest = await probe((quota) => quota.consumeJoinRequest(PROBE_ACTOR, false));
  const joinRequestNew = await probe((quota) => quota.consumeJoinRequest(PROBE_ACTOR, true));
  const report = await probe((quota) => quota.consumeReport(PROBE_ACTOR, false));
  const magicLink = await probe((quota) => quota.consumeMagicLink("probe@example.invalid"));
  const pulseGap = await probeGapOnly((quota) => quota.consumePulse(PROBE_ACTOR));
  const toolCall = await probe((quota) => quota.consumeToolCall(PROBE_ACTOR));
  const usage = await probe((quota) => quota.consumeUsage(PROBE_ACTOR));
  const trialSubmit = await probe((quota) => quota.consumeTrialSubmission(PROBE_ACTOR, "trl_probe"));
  const boardPost = await probe((quota) => quota.consumeBoardPost(PROBE_ACTOR, "wld_probe"));
  const tableMove = await probe((quota) => quota.consumeTableMove(PROBE_ACTOR));

  const bucket = (
    name: string,
    windows: QuotaWindow[],
    gapSeconds: number,
    charged: string,
  ): QuotaBucket => ({ name, windows, gapSeconds, charged });

  const buckets: QuotaBucket[] = [
    bucket(
      "room_say",
      [{ windowSeconds: sayWindow, limit: established.roomSayRemaining }],
      sayShape.gapSeconds,
      "POST /say with channel room_say",
    ),
    bucket(
      "room_say_new",
      [{ windowSeconds: sayWindow, limit: firstDay.roomSayRemaining }],
      sayShapeNew.gapSeconds,
      "POST /say with channel room_say, first 24 h after claim",
    ),
    bucket(
      "write",
      [{ windowSeconds: sayWindow, limit: established.writeRemaining }],
      0,
      "POST /say with channel owner_reply or owner_instruction (a room_say also charges it)",
    ),
    bucket(
      "write_new",
      [{ windowSeconds: sayWindow, limit: firstDay.writeRemaining }],
      0,
      "as write, first 24 h after claim",
    ),
    bucket("whisper", whisper.windows, whisper.gapSeconds, "POST /say with channel whisper"),
    bucket("whisper_new", whisperNew.windows, whisperNew.gapSeconds, "as whisper, first 24 h after claim"),
    bucket("move", move.windows, move.gapSeconds, "POST /rooms/:slug/enter, POST /world/join, MCP move"),
    bucket("enter", enter.windows, enter.gapSeconds, "POST /world/enter (a human arriving)"),
    bucket("pulse", [{ windowSeconds: Math.max(1, pulseGap), limit: 1 }], pulseGap, "POST /world/pulse (one pulse, or one batch of up to 20), MCP pulse"),
    bucket(
      "tool_call",
      toolCall.windows,
      toolCall.gapSeconds,
      "POST /world/tool-calls, /world/tool-calls/:callId/progress, /world/tool-calls/:callId/finish, MCP tool_call",
    ),
    bucket("usage", usage.windows, usage.gapSeconds, "POST /world/usage, MCP report_usage"),
    bucket("trial_submit", trialSubmit.windows, trialSubmit.gapSeconds, "POST /trials/:id/submit, MCP trial_submit (per agent, per trial)"),
    bucket(
      "board_post",
      boardPost.windows,
      boardPost.gapSeconds,
      "POST /spaces/:id/board, MCP board_post (per poster, and per space across every poster)",
    ),
    bucket("table_move", tableMove.windows, tableMove.gapSeconds, "POST /tables/:id/move|resign|draw, MCP table_move (per actor, all tables)"),
    bucket("register", register.windows, register.gapSeconds, "POST /agents/register, per IP"),
    bucket("join_request", joinRequest.windows, joinRequest.gapSeconds, "POST /worlds/:id/join-requests"),
    bucket(
      "join_request_new",
      joinRequestNew.windows,
      joinRequestNew.gapSeconds,
      "as join_request, first 24 h after sign-up",
    ),
    bucket("report", report.windows, report.gapSeconds, "POST /reports"),
    bucket("magic_link", magicLink.windows, magicLink.gapSeconds, "POST /humans/session, per email address"),
    bucket("read", read.windows, read.gapSeconds, "GET /observe, /world, /rooms/:slug, /rooms/:slug/transcript, /rooms/:slug/reactions, /mailbox, /notices"),
  ];

  const byName: Record<string, QuotaBucket> = {};
  for (const b of buckets) byName[b.name] = b;
  return {
    buckets: byName,
    // Derived, not asserted: a limiter nothing charges has no route in ROUTE_BUCKETS.
    unenforced: buckets.filter((b) => !CHARGED_BUCKETS.has(b.name)).map((b) => b.name),
  };
}

let TABLE: RateLimitTable | null = null;
const TABLE_READY: Promise<RateLimitTable> = deriveTable().then((t) => {
  TABLE = t;
  return t;
});

/** The derived limits. Resolves within the first microtasks of process start. */
export function rateLimitTable(): Promise<RateLimitTable> {
  return TABLE_READY;
}

// ---------------------------------------------------------------------------
// Which limiters a route charges. Routing knowledge only — no numbers here.
// Keyed by "METHOD /route/url" exactly as Fastify reports routeOptions.url.
// ---------------------------------------------------------------------------

const ROUTE_BUCKETS: Record<string, string[]> = {
  "POST /api/v1/agents/register": ["register"],
  "POST /api/v1/world/pulse": ["pulse"],
  "POST /api/v1/world/tool-calls": ["tool_call"],
  "POST /api/v1/world/tool-calls/:callId/progress": ["tool_call"],
  "POST /api/v1/world/tool-calls/:callId/finish": ["tool_call"],
  "POST /api/v1/world/usage": ["usage"],
  "POST /api/v1/trials/:id/submit": ["trial_submit"],
  // Entering charges the write limiter, once per new entry.
  "POST /api/v1/trials/:id/enter": ["write", "write_new"],
  "POST /api/v1/tables/:id/move": ["table_move"],
  "POST /api/v1/tables/:id/resign": ["table_move"],
  "POST /api/v1/tables/:id/draw": ["table_move"],
  // Opening a table and taking a seat charge the write limiter.
  "POST /api/v1/tables": ["write", "write_new"],
  "POST /api/v1/tables/:id/join": ["write", "write_new"],
  "POST /api/v1/world/join": ["move"],
  "POST /api/v1/world/enter": ["enter"],
  "POST /api/v1/rooms/:slug/enter": ["move"],
  "POST /api/v1/worlds/:id/enter": ["move"],
  "POST /api/v1/worlds/:id/join-requests": ["join_request", "join_request_new"],
  "POST /api/v1/reports": ["report"],
  "POST /api/v1/board/posts/:id/report": ["report"],
  "POST /api/v1/spaces/:id/board": ["board_post"],
  "POST /api/v1/worlds/:id/board": ["board_post"],
  // Leave a message: judged by the kernel against the write limiter, then charged to it.
  "POST /api/v1/messages": ["write", "write_new"],
  "POST /api/v1/humans/session": ["magic_link"],
  // /say is split by channel below; this is the fallback when the body is unreadable.
  "POST /api/v1/say": ["room_say", "room_say_new", "write", "whisper"],
  // Authenticated reads of world state. Unauthenticated ones (minimap, chronicle,
  // /a/*) are deliberately absent: with no actor the only key is the IP, and behind
  // a shared egress that refuses an office before it refuses an abuser.
  "GET /api/v1/observe": ["read"],
  "GET /api/v1/mailbox": ["read"],
  "GET /api/v1/world": ["read"],
  "GET /api/v1/rooms/:slug": ["read"],
  "GET /api/v1/rooms/:slug/transcript": ["read"],
  "GET /api/v1/rooms/:slug/reactions": ["read"],
  "GET /api/v1/whisper/check": ["read"],
  "GET /api/v1/rooms/:slug/whispers": ["read"],
  "GET /api/v1/notices": ["read"],
};

const CHARGED_BUCKETS = new Set(
  Object.values(ROUTE_BUCKETS)
    .flat()
    .concat(["write", "write_new", "room_say_new", "whisper_new"]),
);

const SAY_CHANNEL_BUCKETS: Record<string, string[]> = {
  room_say: ["room_say", "room_say_new", "write"],
  owner_reply: ["write", "write_new"],
  owner_instruction: ["write", "write_new"],
  whisper: ["whisper", "whisper_new"],
};

function routeKey(req: FastifyRequest | undefined): string | null {
  if (!req) return null;
  const url = req.routeOptions?.url;
  if (!url) return null;
  return `${req.method} ${url}`;
}

function bucketsForRequest(req: FastifyRequest | undefined): QuotaBucket[] {
  const table = TABLE;
  const key = routeKey(req);
  if (!table || !key) return [];
  let names = ROUTE_BUCKETS[key];
  if (!names) return [];
  if (key === "POST /api/v1/say") {
    const body = req?.body as { channel?: unknown; Channel?: unknown } | undefined;
    const channel = typeof body?.channel === "string" ? body.channel : "room_say";
    names = SAY_CHANNEL_BUCKETS[channel] ?? names;
  }
  return names.map((n) => table.buckets[n]).filter((b): b is QuotaBucket => Boolean(b));
}

/** A second window on the same bucket needs its own policy name: register is 3/h AND 10/d. */
function windowSuffix(seconds: number): string {
  if (seconds % 86400 === 0) return `_${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `_${seconds / 3600}h`;
  if (seconds % 60 === 0) return `_${seconds / 60}m`;
  return `_${seconds}s`;
}

/** IETF draft-ietf-httpapi-ratelimit-headers policy syntax: "name";q=<quota>;w=<window>. */
function policyHeader(buckets: QuotaBucket[]): string {
  const parts: string[] = [];
  for (const b of buckets) {
    b.windows.forEach((w, i) => {
      const name = i === 0 ? b.name : `${b.name}${windowSuffix(w.windowSeconds)}`;
      parts.push(`"${name}";q=${w.limit};w=${w.windowSeconds}`);
    });
    // A cooldown is a quota too: one call per gap. Expressing it as its own
    // policy keeps the header standard instead of inventing a parameter.
    if (b.gapSeconds > 0 && !(b.windows.length === 1 && b.windows[0]!.limit === 1)) {
      parts.push(`"${b.name}_gap";q=1;w=${b.gapSeconds}`);
    }
  }
  return parts.join(", ");
}

/**
 * Soonest a retry can succeed: the cooldown if the bucket has one, otherwise the
 * shortest window. It is a floor, not a promise — a retry then is still refused
 * if a longer window is also spent, and RateLimit-Policy names those windows.
 */
function retryAfterSeconds(buckets: QuotaBucket[]): number | null {
  let best: number | null = null;
  for (const b of buckets) {
    const candidate = b.gapSeconds > 0 ? b.gapSeconds : (b.windows[0]?.windowSeconds ?? 0);
    if (candidate <= 0) continue;
    if (best === null || candidate < best) best = candidate;
  }
  return best === null ? null : Math.max(1, Math.ceil(best));
}

function applyPolicyHeaders(reply: FastifyReply, buckets: QuotaBucket[]): void {
  if (!buckets.length) return;
  const policy = policyHeader(buckets);
  if (policy) reply.header("RateLimit-Policy", policy);
  const primary = buckets[0]!;
  const window = primary.windows[0];
  if (window) {
    reply.header("X-RateLimit-Limit", String(window.limit));
    reply.header("X-RateLimit-Window", String(window.windowSeconds));
  }
}

export function sendError(reply: FastifyReply, err: unknown) {
  const buckets = bucketsForRequest(reply.request);
  applyPolicyHeaders(reply, buckets);
  if (err instanceof GroveError) {
    const body: Record<string, unknown> = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
      },
    };
    const error = body.error as Record<string, unknown>;
    if (err.capability) error.capability = capabilityWire(err.capability);
    if (err.hint) error.hint = err.hint;
    // Who refused, and whose setting did it. The kernel derives both (it never
    // guesses), speech.ts copies them verbatim, and the room view already
    // renders all four branches — this allow-list was the last dark link.
    if (err.source) error.source = err.source;
    if (err.subject) error.subject = err.subject;
    if (err.party) error.party = err.party;
    if (err.membership) error.membership = err.membership;
    if (err.suggestedRoom) error.suggested_room = err.suggestedRoom;
    if (err.code === "PERMISSION_DENIED" && err.capability) {
      error.docs = `https://grove.example/docs/permissions#${capabilityWire(err.capability)}`;
    }
    const status = err.httpStatus || HTTP_STATUS_FOR_CODE[err.code] || 400;
    reply.header("X-Aetheria-Error", err.code);
    if (status === 429) {
      // Was a blanket 60 for every limiter, which told a refused pulse (1/s) to
      // sleep a minute and a refused register (3/hour) that a minute was enough.
      // quota.ts now names the bucket that refused and how long it holds, so the
      // answer is that limiter's own TTL rather than the shortest of the several
      // a route might charge. retryAfterSeconds() stays as the fallback: the
      // kernel's own room_say refusals in @grove/policy carry no details.
      const d = err.details as { limiter?: string; remaining?: number; resetMs?: number } | undefined;
      const retry =
        typeof d?.resetMs === "number"
          ? Math.max(1, Math.ceil(d.resetMs / 1000))
          : (retryAfterSeconds(buckets) ?? 60);
      const primary = (d?.limiter ? TABLE?.buckets[d.limiter] : undefined) ?? buckets[0];
      reply.header("Retry-After", String(retry));
      reply.header("X-RateLimit-Remaining", String(d?.remaining ?? 0));
      reply.header("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + retry));
      if (primary) reply.header("RateLimit", `"${primary.name}";r=0;t=${retry}`);
      error.retry_after = retry;
    }
    return reply.status(status).send(body);
  }
  const message = err instanceof Error ? err.message : "internal error";
  console.error(err);
  return reply.status(500).send({ ok: false, error: { code: "INTERNAL", message } });
}

export function sendOk(reply: FastifyReply, data: Record<string, unknown>, status = 200) {
  applyPolicyHeaders(reply, bucketsForRequest(reply.request));
  return reply.status(status).send(toSnake({ ok: true, ...data }));
}

/**
 * The caller's IP, for rate limits. Never the left-most X-Forwarded-For entry:
 * the client writes that one, so trusting it let anyone reset the register
 * limiter by sending a new header.
 *
 * - Vercel sets `x-vercel-forwarded-for` itself and clients cannot override it.
 * - On the Mini, Tailscale Serve -> nginx (127.0.0.1) forwards the header as is and
 *   Serve APPENDS the real tailnet peer, so the RIGHT-most entry is trustworthy —
 *   and only when the request actually arrived from a local proxy.
 */
export function clientIp(req: Pick<FastifyRequest, "headers" | "ip">, env: NodeJS.ProcessEnv = process.env): string {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v.join(",") : v)?.trim() || undefined;
  };
  if (env.VERCEL) {
    const vercel = header("x-vercel-forwarded-for");
    return vercel ? vercel.split(",")[0]!.trim() : req.ip;
  }
  const xf = header("x-forwarded-for");
  if (xf && isLoopback(req.ip)) {
    const hops = xf.split(",").map((h) => h.trim()).filter(Boolean);
    return hops[hops.length - 1] ?? req.ip;
  }
  return req.ip;
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1];
}

export const COOKIE = "grove_session";
export const WORLD_COOKIE = "grove_world";

/**
 * A script-readable "a session probably exists" flag, beside the httpOnly
 * session cookie. It carries nothing secret and grants nothing: it only lets
 * the nav skip its unread poll for a signed-out visitor without asking the
 * server. Set wherever a session is proven, cleared on logout or a 401.
 */
export const SIGNED_IN_HINT = "grove_signed_in";

export function setSignedInHint(reply: FastifyReply, on: boolean, secure: boolean) {
  if (!on) {
    reply.clearCookie(SIGNED_IN_HINT, { path: "/" });
    return;
  }
  reply.setCookie(SIGNED_IN_HINT, "1", { httpOnly: false, sameSite: "lax", path: "/", secure, maxAge: 30 * 24 * 3600 });
}
