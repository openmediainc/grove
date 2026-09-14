import type { RefusalInput } from "@grove/ui";

/**
 * One error style. Every caught failure on a page used to be printed as the
 * raw `err.message` in red — server prose, "Failed to fetch", "Unexpected token
 * <" — with nothing to do next. This turns whatever `api()` threw (or a
 * sentence a form wrote itself) into a plain cause plus what to do about it.
 *
 * Permission-kernel refusals are NOT described here: they carry a flattened
 * `PolicyDecision` and @grove/ui's `describeRefusal` already names the right
 * door, so they come back as `kind: "refused"` with the `RefusalInput` attached.
 *
 * Pure: no DOM, no React, so it is unit tested directly.
 */

export type ApiErrorKind =
  /** A sentence the page wrote itself (form validation). Shown as is. */
  | "message"
  | "refused"
  /** FROZEN: an operator paused this actor or feature. */
  | "frozen"
  | "sign_in"
  | "invite"
  | "age_gate"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "conflict"
  | "network"
  | "server"
  | "unknown";

export interface ApiErrorView {
  kind: ApiErrorKind;
  /** One short line: what happened. */
  cause: string;
  /** What to do about it, or null when the cause already says it. */
  fix: string | null;
  /** Worth offering a Retry button, when the caller has one. */
  retryable: boolean;
  /** Offer a sign-in link. */
  signIn: boolean;
  /** Seconds, on a rate limit that said how long it holds. */
  retryAfter?: number;
  /** Set only when `kind === "refused"`. */
  refusal?: RefusalInput;
}

export interface DescribeOptions {
  /** The verb for "Sign in to …" (e.g. "follow"). */
  action?: string;
  /** Passed through to the refusal copy. */
  senderKind?: "human" | "agent";
  channel?: RefusalInput["channel"];
  recipientKind?: RefusalInput["recipientKind"];
}

type ApiErrorShape = {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
  body?: {
    error?: {
      code?: string;
      message?: string;
      capability?: string;
      hint?: string;
      source?: string;
      subject?: string;
      /** #62: sender or recipient, on ceiling refusals too. */
      party?: string;
      membership?: string;
      retry_after?: number;
    };
  };
};

/** Codes the permission kernel (or speech rules) refuse with; RefusalNotice says them. */
const REFUSAL_CODES = new Set([
  "PERMISSION_DENIED",
  "BLOCKED",
  "MUTED",
  "NOT_ADDRESSABLE",
  "ROOM_FORBIDDEN",
  "ROOM_FULL",
  "UNCLAIMED",
]);

const INVALID_CODES = new Set([
  "INVALID",
  "VALIDATION",
  "VALIDATION_ERROR",
  "BODY_TOO_LONG",
  "RECIPIENTS_INVALID",
  "IDEMPOTENCY_REQUIRED",
]);

const CONFLICT_CODES = new Set(["CONFLICT", "SLUG_TAKEN", "SEAT_TAKEN", "CLAIM_LIMIT"]);

/** Pull the decision out of whatever `api()` threw, without trusting any of it. */
export function toRefusalInput(
  err: unknown,
  senderKind: "human" | "agent",
  extra: Pick<RefusalInput, "channel" | "recipientKind"> = {},
): RefusalInput {
  const e = (err ?? {}) as ApiErrorShape;
  const body = e.body?.error;
  const source = body?.source;
  const subject = body?.subject;
  const code = body?.code ?? e.code;
  // The server already says how long the limiter holds; "wait a moment" is
  // kinder with the moment attached.
  const retry =
    code === "RATE_LIMITED" && typeof body?.retry_after === "number" && body.retry_after > 0
      ? `Try again in ${body.retry_after}s.`
      : undefined;
  return {
    ...extra,
    code,
    capability: body?.capability,
    source: source === "actor" || source === "space" || source === "room" ? source : undefined,
    membership: body?.membership === "member" || body?.membership === "non_member" ? body.membership : undefined,
    subject: subject === "sender" || subject === "recipient" ? subject : undefined,
    party: body?.party === "sender" || body?.party === "recipient" ? body.party : undefined,
    message: body?.message ?? e.message,
    hint: body?.hint ?? retry,
    senderKind,
  };
}

/** "40s", "2 min", "1 h". */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

/** Server prose as a sentence: trimmed, capitalised, ending in a stop. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

const NETWORK_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|network error|fetch failed|err_internet|offline/i;
/** `api()` parses JSON before checking status, so an HTML 502 page lands as a SyntaxError. */
const UNREADABLE_MESSAGE = /unexpected token|not valid json|json\.parse|unexpected end of json/i;

/**
 * `null` for "no error" (null, undefined, "", false), so a caller can pass its
 * state straight in.
 */
export function describeApiError(err: unknown, opts: DescribeOptions = {}): ApiErrorView | null {
  if (err === null || err === undefined || err === false || err === "") return null;

  const base = { retryable: false, signIn: false } as const;

  if (typeof err === "string") {
    return { ...base, kind: "message", cause: sentence(err), fix: null };
  }
  if (typeof err !== "object") {
    return { ...base, kind: "unknown", cause: "That didn't work.", fix: "Try again.", retryable: true };
  }

  const e = err as ApiErrorShape;
  const body = e.body && typeof e.body === "object" ? e.body.error : undefined;
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = str(body?.code) ?? str(e.code);
  const message = str(body?.message) ?? str(e.message);

  if (code && REFUSAL_CODES.has(code)) {
    return {
      ...base,
      kind: "refused",
      cause: message ? sentence(message) : "That was refused.",
      fix: null,
      refusal: toRefusalInput(err, opts.senderKind ?? "human", {
        channel: opts.channel,
        recipientKind: opts.recipientKind,
      }),
    };
  }

  if (code === "RATE_LIMITED" || status === 429) {
    const after = typeof body?.retry_after === "number" && body.retry_after > 0 ? body.retry_after : undefined;
    return {
      ...base,
      kind: "rate_limited",
      cause: "Too many tries.",
      fix: after ? `Try again in ${formatWait(after)}.` : "Wait a moment, then try again.",
      retryable: true,
      retryAfter: after,
    };
  }

  if (code === "UNAUTHORIZED" || code === "UNAUTHENTICATED" || status === 401) {
    return {
      ...base,
      kind: "sign_in",
      cause: "You're not signed in.",
      fix: `Sign in to ${opts.action?.trim() || "continue"}.`,
      signIn: true,
    };
  }

  if (code === "INVITE_REQUIRED") {
    return {
      ...base,
      kind: "invite",
      cause: "Glasshouse is invite-only right now.",
      fix: "Use the invite link or code you were sent.",
    };
  }

  if (code === "AGE_GATE") {
    return {
      ...base,
      kind: "age_gate",
      cause: "Glasshouse is for people 18 and over.",
      fix: "Confirm your age to continue.",
    };
  }

  if (code === "NOT_FOUND" || status === 404) {
    // Deliberately says nothing about WHY: private things answer 404 too, and
    // this line must not confirm that something private exists.
    return {
      ...base,
      kind: "not_found",
      cause: "That isn't here.",
      fix: "Check the link, or go back and pick it again.",
    };
  }

  if (code === "FROZEN") {
    return {
      ...base,
      kind: "frozen",
      cause: message ? sentence(message) : "This is paused for now.",
      fix: "An operator paused it. Try again later.",
    };
  }

  if (code && INVALID_CODES.has(code)) {
    return {
      ...base,
      kind: "invalid",
      cause: message ? sentence(message) : "Something in that isn't right.",
      fix: "Fix it and try again.",
    };
  }

  if (code && CONFLICT_CODES.has(code)) {
    const fix =
      code === "SLUG_TAKEN"
        ? "Pick another one."
        : code === "CLAIM_LIMIT"
          ? null
          : "Refresh to see the latest, then try again.";
    return {
      ...base,
      kind: "conflict",
      cause: message ? sentence(message) : "That changed while you were on it.",
      fix,
      retryable: code === "CONFLICT" || code === "SEAT_TAKEN",
    };
  }

  if (code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL" || (status !== undefined && status >= 500)) {
    return {
      ...base,
      kind: "server",
      cause: code === "UPSTREAM_UNAVAILABLE" && message ? sentence(message) : "Glasshouse hit a problem on its side.",
      fix: "Try again in a moment.",
      retryable: true,
    };
  }

  if (status === 403) {
    // A bare 403 with no kernel code: still a refusal, said without guessing whose.
    return {
      ...base,
      kind: "refused",
      cause: message ? sentence(message) : "That was refused.",
      fix: null,
      refusal: toRefusalInput(err, opts.senderKind ?? "human", {
        channel: opts.channel,
        recipientKind: opts.recipientKind,
      }),
    };
  }

  if (status === undefined && message && NETWORK_MESSAGE.test(message)) {
    return {
      ...base,
      kind: "network",
      cause: "Couldn't reach Glasshouse.",
      fix: "Check your connection and retry.",
      retryable: true,
    };
  }

  if (status === undefined && (e.name === "SyntaxError" || (message && UNREADABLE_MESSAGE.test(message)))) {
    return {
      ...base,
      kind: "server",
      cause: "Glasshouse sent back something unreadable.",
      fix: "Try again in a moment.",
      retryable: true,
    };
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return {
      ...base,
      kind: "invalid",
      cause: message ? sentence(message) : "That request wasn't accepted.",
      fix: "Check it and try again.",
    };
  }

  return {
    ...base,
    kind: "unknown",
    cause: message ? sentence(message) : "That didn't work.",
    fix: "Try again.",
    retryable: true,
  };
}
