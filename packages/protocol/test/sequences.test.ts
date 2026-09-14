import { describe, expect, it } from "vitest";
import {
  SEQUENCE_MAX_BYTES,
  SEQUENCE_MAX_SHOTS,
  SEQUENCE_URL_MAX,
  decodeSequence,
  encodeSequence,
  parseSequenceRef,
  readSequenceTitle,
  sequenceDuration,
  validateSequence,
  type Sequence,
} from "../src/sequences.js";

const key = (tx: number, ty: number, zoom = 1) => ({ tx, ty, zoom });

const SAMPLE = {
  title: "Morning at the  Workshop ☀️",
  shots: [
    { kind: "push", from: key(10, 10, 0.5), to: key(12.34, 9.87, 1.456), durationMs: 4000 },
    { kind: "orbit", from: key(12, 6), to: key(12, 10), durationMs: 8000, follow: "lantern" },
    { kind: "path", from: key(12, 10), to: key(-20, 44, 0.8), durationMs: 6049 },
    { kind: "hold", from: key(-20, 44, 0.8), durationMs: 2000 },
  ],
};

function ok(raw: unknown): Sequence {
  const r = validateSequence(raw);
  if (!r.ok) throw new Error(r.message);
  return r.sequence;
}

describe("validateSequence", () => {
  it("normalises a good sequence", () => {
    const s = ok(SAMPLE);
    expect(s.v).toBe(1);
    expect(s.title).toBe("Morning at the Workshop ☀️");
    expect(s.shots[0]!.to).toEqual({ tx: 12.3, ty: 9.9, zoom: 1.46 });
    expect(s.shots[1]!.follow).toBe("lantern");
    expect(s.shots[2]!.durationMs).toBe(6000);
    // A hold's end is its start.
    expect(s.shots[3]!.to).toEqual(s.shots[3]!.from);
    expect(sequenceDuration(s)).toBe(20_000);
  });

  it("refuses what is not a sequence", () => {
    expect(validateSequence(null).ok).toBe(false);
    expect(validateSequence([]).ok).toBe(false);
    expect(validateSequence({ shots: [] }).ok).toBe(false);
    expect(validateSequence({ v: 2, shots: SAMPLE.shots }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], kind: "dolly" }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], from: { tx: 1, ty: 2 } }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], to: key(Number.NaN, 1) }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], to: key(99_999, 1) }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], to: key(1, 1, 50) }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], durationMs: 100 }] }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...SAMPLE.shots[0], follow: "a private plot name" }] }).ok).toBe(false);
  });

  it("caps shots at 12 and the running time at 60 s", () => {
    const shot = { kind: "hold", from: key(0, 0), durationMs: 1000 };
    expect(validateSequence({ shots: Array(SEQUENCE_MAX_SHOTS).fill(shot) }).ok).toBe(true);
    expect(validateSequence({ shots: Array(SEQUENCE_MAX_SHOTS + 1).fill(shot) }).ok).toBe(false);
    expect(validateSequence({ shots: [{ ...shot, durationMs: 30_000 }, { ...shot, durationMs: 30_000 }] }).ok).toBe(true);
    expect(validateSequence({ shots: [{ ...shot, durationMs: 30_000 }, { ...shot, durationMs: 30_100 }] }).ok).toBe(false);
  });

  it("keeps the stored form under the size cap", () => {
    const s = ok(SAMPLE);
    expect(JSON.stringify(s).length).toBeLessThan(SEQUENCE_MAX_BYTES);
  });
});

describe("readSequenceTitle", () => {
  it("is one short line or nothing", () => {
    expect(readSequenceTitle("  ")).toEqual({ ok: true, title: null });
    expect(readSequenceTitle(undefined)).toEqual({ ok: true, title: null });
    expect(readSequenceTitle("a\nb").ok).toBe(false);
    expect(readSequenceTitle("x".repeat(60)).ok).toBe(true);
    expect(readSequenceTitle("x".repeat(61)).ok).toBe(false);
    expect(readSequenceTitle(42).ok).toBe(false);
  });
});

describe("encode / decode", () => {
  it("round-trips through a URL-safe string", () => {
    const s = ok(SAMPLE);
    const enc = encodeSequence(s);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.length).toBeLessThan(SEQUENCE_URL_MAX);
    expect(decodeSequence(enc)).toEqual(s);
    const url = new URL(`https://example.test/?seq=${enc}`);
    expect(decodeSequence(url.searchParams.get("seq")!)).toEqual(s);
  });

  it("round-trips an untitled sequence", () => {
    const s = ok({ shots: [SAMPLE.shots[3]] });
    expect(decodeSequence(encodeSequence(s))).toEqual(s);
  });

  it("refuses garbage and tampering", () => {
    expect(decodeSequence("")).toBeNull();
    expect(decodeSequence("not base64!")).toBeNull();
    expect(decodeSequence("e30")).toBeNull(); // "{}"
    const enc = encodeSequence(ok(SAMPLE));
    expect(decodeSequence(enc.slice(0, enc.length - 7))).toBeNull();
  });
});

describe("parseSequenceRef", () => {
  it("tells a stored id from an inline sequence", () => {
    expect(parseSequenceRef("seq_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3")).toEqual({ kind: "id", id: "seq_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3" });
    const s = ok(SAMPLE);
    expect(parseSequenceRef(encodeSequence(s))).toEqual({ kind: "inline", sequence: s });
    expect(parseSequenceRef("seq_nope")).toBeNull();
    expect(parseSequenceRef(null)).toBeNull();
  });
});
