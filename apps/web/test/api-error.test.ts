import { describe, expect, it } from "vitest";
import { describeApiError, formatWait, toRefusalInput } from "../lib/api-error";

/** The shape `api()` throws. */
function apiErr(status: number, error: Record<string, unknown> | null, message = "boom") {
  return Object.assign(new Error(message), {
    status,
    code: error?.code,
    body: error ? { ok: false, error } : {},
  });
}

describe("describeApiError", () => {
  it("returns null for no error", () => {
    for (const none of [null, undefined, "", false]) expect(describeApiError(none)).toBeNull();
  });

  it("shows a page's own sentence as is, as a sentence", () => {
    const v = describeApiError("give a reason");
    expect(v).toMatchObject({ kind: "message", cause: "Give a reason.", fix: null, signIn: false, retryable: false });
    expect(describeApiError("A budget is positive.")!.cause).toBe("A budget is positive.");
  });

  it("NOT_FOUND says nothing about why (private things 404 too)", () => {
    const v = describeApiError(apiErr(403, { code: "NOT_FOUND", message: "space secret-club not found" }))!;
    expect(v.kind).toBe("not_found");
    expect(v.cause).toBe("That isn't here.");
    expect(v.cause + v.fix).not.toMatch(/secret-club|private/i);
    expect(describeApiError(apiErr(404, null))!.kind).toBe("not_found");
  });

  it("INVITE_REQUIRED", () => {
    const v = describeApiError(apiErr(403, { code: "INVITE_REQUIRED", message: "A valid invite code is required." }))!;
    expect(v).toMatchObject({ kind: "invite", cause: "Glasshouse is invite-only right now." });
    expect(v.fix).toMatch(/invite/);
  });

  it("RATE_LIMITED with retry_after says how long", () => {
    const v = describeApiError(apiErr(429, { code: "RATE_LIMITED", message: "slow down", retry_after: 40 }))!;
    expect(v).toMatchObject({ kind: "rate_limited", cause: "Too many tries.", fix: "Try again in 40s.", retryAfter: 40, retryable: true });
  });

  it("RATE_LIMITED without retry_after, and a bare 429", () => {
    expect(describeApiError(apiErr(429, { code: "RATE_LIMITED" }))!.fix).toBe("Wait a moment, then try again.");
    expect(describeApiError(apiErr(429, null))!.kind).toBe("rate_limited");
  });

  it("AGE_GATE", () => {
    const v = describeApiError(apiErr(403, { code: "AGE_GATE", message: "Age attestation required." }))!;
    expect(v).toMatchObject({ kind: "age_gate", cause: "Glasshouse is for people 18 and over." });
  });

  it("INVALID / VALIDATION keep the server's specific sentence as the cause", () => {
    for (const code of ["INVALID", "VALIDATION", "VALIDATION_ERROR", "BODY_TOO_LONG"]) {
      const v = describeApiError(apiErr(400, { code, message: "slug must be 3-40 characters" }))!;
      expect(v.kind).toBe("invalid");
      expect(v.cause).toBe("Slug must be 3-40 characters.");
      expect(v.fix).toBe("Fix it and try again.");
    }
  });

  it("UNAUTHORIZED / UNAUTHENTICATED / 401 offer sign-in with the action", () => {
    const v = describeApiError(apiErr(401, { code: "UNAUTHORIZED", message: "Sign in required." }), { action: "follow" })!;
    expect(v).toMatchObject({ kind: "sign_in", signIn: true, fix: "Sign in to follow." });
    expect(describeApiError(apiErr(401, null))!.fix).toBe("Sign in to continue.");
    expect(describeApiError({ code: "UNAUTHENTICATED" })!.kind).toBe("sign_in");
  });

  it("kernel refusals delegate to RefusalNotice with the decision attached", () => {
    const err = apiErr(403, {
      code: "PERMISSION_DENIED",
      message: "nope",
      capability: "speak_to_humans",
      source: "space",
      membership: "non_member",
    });
    const v = describeApiError(err, { channel: "message", recipientKind: "agent" })!;
    expect(v.kind).toBe("refused");
    expect(v.refusal).toMatchObject({
      code: "PERMISSION_DENIED",
      capability: "speak_to_humans",
      source: "space",
      membership: "non_member",
      channel: "message",
      recipientKind: "agent",
      senderKind: "human",
    });
    for (const code of ["BLOCKED", "MUTED", "ROOM_FORBIDDEN", "ROOM_FULL", "UNCLAIMED", "NOT_ADDRESSABLE"]) {
      expect(describeApiError(apiErr(403, { code }))!.kind).toBe("refused");
    }
    // A bare 403 with no code is still a refusal, never guessed as something else.
    expect(describeApiError(apiErr(403, null))!.refusal).toBeDefined();
  });

  it("conflicts", () => {
    expect(describeApiError(apiErr(409, { code: "SLUG_TAKEN", message: "That slug is taken." }))).toMatchObject({
      kind: "conflict",
      cause: "That slug is taken.",
      fix: "Pick another one.",
    });
    expect(describeApiError(apiErr(409, { code: "CONFLICT", message: "stale" }))!.retryable).toBe(true);
    expect(describeApiError(apiErr(409, { code: "CLAIM_LIMIT", message: "You may claim at most 10 agents." }))!.fix).toBeNull();
  });

  it("FROZEN", () => {
    expect(describeApiError(apiErr(503, { code: "FROZEN", message: "This inhabitant is suspended." }))).toMatchObject({
      kind: "frozen",
      cause: "This inhabitant is suspended.",
    });
  });

  it("network failure (fetch TypeError, no status)", () => {
    for (const msg of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      const v = describeApiError(new TypeError(msg))!;
      expect(v).toMatchObject({
        kind: "network",
        cause: "Couldn't reach Glasshouse.",
        fix: "Check your connection and retry.",
        retryable: true,
      });
    }
  });

  it("5xx, INTERNAL and an unreadable HTML body are server-side", () => {
    expect(describeApiError(apiErr(500, { code: "INTERNAL", message: "pg exploded at line 4" }))).toMatchObject({
      kind: "server",
      cause: "Glasshouse hit a problem on its side.",
      retryable: true,
    });
    expect(describeApiError(apiErr(502, null))!.kind).toBe("server");
    expect(describeApiError(new SyntaxError("Unexpected token '<', \"<!DOCTYPE\" is not valid JSON"))!.kind).toBe("server");
    expect(describeApiError(apiErr(502, { code: "UPSTREAM_UNAVAILABLE", message: "Checkout is unavailable right now." }))!.cause).toBe(
      "Checkout is unavailable right now.",
    );
  });

  it("unknown shapes never throw and still say something", () => {
    expect(describeApiError(new Error("weird thing"))).toMatchObject({ kind: "unknown", cause: "Weird thing.", fix: "Try again." });
    expect(describeApiError({})).toMatchObject({ kind: "unknown", cause: "That didn't work." });
    expect(describeApiError(42)!.kind).toBe("unknown");
    expect(describeApiError({ body: "not an object", status: "500" })!.kind).toBe("unknown");
    expect(describeApiError(apiErr(418, { code: "TEAPOT", message: "short and stout" }))).toMatchObject({
      kind: "invalid",
      cause: "Short and stout.",
    });
  });
});

describe("formatWait", () => {
  it("seconds, minutes, hours", () => {
    expect(formatWait(40)).toBe("40s");
    expect(formatWait(0)).toBe("1s");
    expect(formatWait(90)).toBe("2 min");
    expect(formatWait(7200)).toBe("2 h");
  });
});

describe("toRefusalInput", () => {
  it("attaches the limiter's wait as the hint", () => {
    expect(toRefusalInput(apiErr(429, { code: "RATE_LIMITED", retry_after: 12 }), "human").hint).toBe("Try again in 12s.");
    expect(toRefusalInput(null, "agent")).toMatchObject({ senderKind: "agent", code: undefined });
    expect(toRefusalInput(apiErr(403, { code: "PERMISSION_DENIED", party: "recipient" }), "human").party).toBe("recipient");
    expect(toRefusalInput(apiErr(403, { code: "PERMISSION_DENIED", party: "someone" }), "human").party).toBeUndefined();
  });
});
