/**
 * Batch pulse (AGT-10).
 *
 * The 1/s pulse cap used to make a fast agent choose between honesty and
 * throughput: three phases inside one second meant two refusals, so the map
 * and the ledger showed a slower, simpler agent than the one that ran. A batch
 * lets it report every phase it actually went through, each with the moment it
 * really happened, in ONE request that still spends ONE pulse of the cap.
 *
 * This file holds the rules that need no database — the wire shape, the clock
 * and the event id — so they can be tested (and read) on their own. The write
 * itself lives beside the single pulse in PresenceService, so a batch item and
 * a single pulse cannot be validated or stored differently.
 *
 * THE RULES, AND WHY THESE NUMBERS
 *
 *  * PULSE_BATCH_MAX = 20 items. One batch spends the same 1/s gap as a single
 *    pulse, so the hard ceiling is 20 events a second per agent. A phase change
 *    every 50 ms is already faster than anything a watcher can read; 20 keeps
 *    the worst case bounded (every item is one UPDATE and one trigger run, in
 *    one transaction) while leaving honest agents a lot of headroom.
 *
 *  * PULSE_MAX_AGE_SECONDS = 300. An item may be back-dated by at most five
 *    minutes — the point at which presence itself calls a silent body offline.
 *    Older than that is refused `TIMESTAMP_STALE`, not rewritten to a time it
 *    did not happen at.
 *
 *  * PULSE_FUTURE_TOLERANCE_MS = 2000. A client clock slightly ahead of ours is
 *    normal; up to 2 s ahead is clamped to the server's receive time (reported
 *    `clamped`). Further ahead is refused `TIMESTAMP_FUTURE`: a body cannot
 *    have done something it has not done yet.
 *
 *  * ORDER IS THE ARRAY'S. Items are applied in the order sent. A timestamp
 *    that goes backwards (or equals its predecessor, or predates the body's
 *    latest stored pulse) is moved forward by the smallest step that keeps the
 *    timeline strictly increasing, and reported `clamped`. Items are never
 *    reordered and never dropped for being out of order.
 *
 *  * IDEMPOTENCY: an item may carry `id`, a client event id (≤64 of
 *    `A-Za-z0-9._:-`). An id seen in the last PULSE_DEDUPE_TTL_SECONDS (600) is
 *    reported `duplicate` and not written again. 600 is 2x the max age, which
 *    is what makes it sufficient: an item is only accepted while its `at` is
 *    under 300 s old, so any retry the server would still accept arrives while
 *    the id is still remembered. A retry made only of duplicates spends no
 *    quota, so a client whose response got lost is never refused by its own
 *    cooldown.
 */
import { GroveError } from "../errors.js";

export const PULSE_BATCH_MAX = 20;
export const PULSE_MAX_AGE_SECONDS = 300;
export const PULSE_FUTURE_TOLERANCE_MS = 2000;
export const PULSE_DEDUPE_TTL_SECONDS = 600;
export const PULSE_EVENT_ID_MAX = 64;

const EVENT_ID_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * One pulse as it came off the wire, before validation. Single and batch, REST
 * and MCP all build this with `pulseInputFromWire`, so a field a pulse learns
 * to carry is carried by a batch item without a second parser.
 */
export interface PulseInput {
  verb: string;
  detail?: string | null;
  url?: string | null;
  errorText?: string | null;
  /** Batch only: when this actually happened. ISO 8601 or epoch milliseconds. */
  at?: string | number | null;
  /** Batch only: the client's event id, so a retry is not logged twice. */
  id?: string | null;
}

/** Why a batch item was not written. `INVALID` covers the same rules as a single pulse. */
export type PulseRefusalCode = "INVALID" | "TIMESTAMP_FUTURE" | "TIMESTAMP_STALE";

export interface PulseItemResult {
  /** Position in the array that was sent. Results come back in the same order. */
  index: number;
  id: string | null;
  status: "applied" | "duplicate" | "refused";
  verb: string | null;
  /**
   * When the item landed: the stored pulse time for `applied`, the original
   * landing time for a `duplicate` when it is still known, null for `refused`.
   */
  pulsedAt: string | null;
  /** True when the stored time differs from the `at` that was sent. */
  clamped: boolean;
  /** Refused only. */
  code?: PulseRefusalCode;
  /** Refused only: a sentence naming the rule, same as the single pulse's error message. */
  reason?: string;
}

/** Accept snake_case off the wire and camelCase from JS clients, for every field. */
export function pulseInputFromWire(raw: unknown): PulseInput {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawDetail = b.detail ?? b.note;
  const rawErr = b.error_text ?? b.errorText;
  const rawAt = b.at;
  return {
    verb: String(b.verb ?? ""),
    detail: rawDetail == null ? null : String(rawDetail),
    url: b.url == null ? null : String(b.url),
    errorText: rawErr == null ? null : String(rawErr),
    at: typeof rawAt === "number" || typeof rawAt === "string" ? rawAt : rawAt == null ? null : String(rawAt),
    id: b.id == null ? null : String(b.id),
  };
}

/**
 * `{ pulses: [...] }` → the items, or null when the body is a single pulse.
 * Whole-request problems (not an array, empty, too many, mixed with a single
 * pulse) are refused outright; a bad ITEM is not, it is refused per item.
 */
export function pulseBatchFromWire(raw: unknown): PulseInput[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (!("pulses" in b) || b.pulses === undefined) return null;
  if (!Array.isArray(b.pulses)) {
    throw new GroveError("INVALID", "pulses must be an array of pulses.");
  }
  if (b.verb !== undefined) {
    throw new GroveError("INVALID", "Send one pulse ({ verb, ... }) or a batch ({ pulses: [...] }), not both.");
  }
  assertBatchSize(b.pulses.length);
  return b.pulses.map(pulseInputFromWire);
}

export function assertBatchSize(n: number): void {
  if (n === 0) throw new GroveError("INVALID", "pulses must contain at least one pulse.");
  if (n > PULSE_BATCH_MAX) {
    throw new GroveError("INVALID", `A batch carries at most ${PULSE_BATCH_MAX} pulses; this one has ${n}.`, {
      hint: `Split it: one batch per second, ${PULSE_BATCH_MAX} pulses each.`,
    });
  }
}

/** A client event id, or null. Throws INVALID (refused per item) when malformed. */
export function normalisePulseEventId(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw);
  if (!value) return null;
  if (value.length > PULSE_EVENT_ID_MAX || !EVENT_ID_RE.test(value)) {
    throw new GroveError(
      "INVALID",
      `id must be 1-${PULSE_EVENT_ID_MAX} characters of A-Z a-z 0-9 . _ : -`,
    );
  }
  return value;
}

export type ResolvedPulseAt =
  | { ok: true; at: number; clamped: boolean }
  | { ok: false; code: PulseRefusalCode; reason: string };

/**
 * Place one item's `at` on the server clock. No `at` means "now" — the moment
 * the batch was received — which is what a single pulse has always meant.
 */
export function resolvePulseAt(raw: unknown, receivedAt: number): ResolvedPulseAt {
  if (raw == null || raw === "") return { ok: true, at: receivedAt, clamped: false };
  const at =
    typeof raw === "number" ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : Date.parse(String(raw));
  if (!Number.isFinite(at)) {
    return { ok: false, code: "INVALID", reason: "at must be an ISO 8601 timestamp or epoch milliseconds." };
  }
  if (at > receivedAt + PULSE_FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      code: "TIMESTAMP_FUTURE",
      reason: `at is ${Math.round((at - receivedAt) / 1000)}s ahead of the server clock (tolerance ${PULSE_FUTURE_TOLERANCE_MS / 1000}s).`,
    };
  }
  if (at < receivedAt - PULSE_MAX_AGE_SECONDS * 1000) {
    return {
      ok: false,
      code: "TIMESTAMP_STALE",
      reason: `at is more than ${PULSE_MAX_AGE_SECONDS}s old; a batch may only report the last ${PULSE_MAX_AGE_SECONDS / 60} minutes.`,
    };
  }
  if (at > receivedAt) return { ok: true, at: receivedAt, clamped: true };
  return { ok: true, at, clamped: false };
}

/** Redis key remembering that an event id landed. Not under `ratelimit:` — it is not a limiter. */
export function pulseSeenKey(actorId: string, eventId: string): string {
  return `pulse:seen:${actorId}:${eventId}`;
}
