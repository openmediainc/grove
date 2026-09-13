import { describe, expect, it } from "vitest";
import type { WhisperLine } from "../lib/whisper";
import { fetchWhisperHistory, mergeWhisperLines, whisperLineFromWire } from "../lib/whisper-history";

const line = (id: string, created_at: string, extra: Partial<WhisperLine> = {}): WhisperLine => ({
  id,
  body: `b-${id}`,
  direction: "out",
  other_id: "hum_x",
  other_kind: "human",
  created_at,
  ...extra,
});

describe("whisper history", () => {
  it("maps the wire, with a refusal only on an outgoing line", () => {
    const out = whisperLineFromWire({
      id: "s1",
      body: "hi",
      direction: "out",
      other_id: "agt_a",
      other_kind: "agent",
      created_at: "2026-09-13T10:00:00.000Z",
      undelivered: { actor_id: "agt_a", code: "BLOCKED" },
    });
    expect(out.undelivered).toMatchObject({ code: "BLOCKED", channel: "whisper", recipientKind: "agent" });
    const inbound = whisperLineFromWire({
      id: "s2",
      body: "yo",
      direction: "in",
      other_id: "hum_b",
      other_kind: "human",
      created_at: "2026-09-13T10:00:00.000Z",
      undelivered: { actor_id: "hum_b", code: "MUTED" },
    });
    expect(inbound.undelivered).toBeNull();
    expect(inbound.direction).toBe("in");
  });

  it("merges by id, oldest first, server time wins and the live refusal is kept", () => {
    const live = line("a", "2026-09-13T10:05:00.000Z", { undelivered: { code: "NOT_ADDRESSABLE", source: "actor" } });
    const stored = [
      line("b", "2026-09-13T10:01:00.000Z"),
      line("a", "2026-09-13T10:04:59.000Z", { undelivered: { code: "NOT_ADDRESSABLE" } }),
    ];
    const merged = mergeWhisperLines([live], stored);
    expect(merged.map((l) => l.id)).toEqual(["b", "a"]);
    expect(merged[1]!.created_at).toBe("2026-09-13T10:04:59.000Z");
    expect(merged[1]!.undelivered).toEqual({ code: "NOT_ADDRESSABLE", source: "actor" });
  });

  it("replaceBefore drops lines the server stopped returning, but keeps ones newer than the fetch", () => {
    const cur = [line("gone", "2026-09-13T09:00:00.000Z"), line("fresh", "2026-09-13T11:00:00.000Z")];
    const stored = [line("kept", "2026-09-13T10:00:00.000Z")];
    const fetchedAt = Date.parse("2026-09-13T10:30:00.000Z");
    expect(mergeWhisperLines(cur, stored, { replaceBefore: fetchedAt }).map((l) => l.id)).toEqual(["kept", "fresh"]);
    expect(mergeWhisperLines(cur, stored).map((l) => l.id)).toEqual(["gone", "kept", "fresh"]);
    // Nothing stored (everything hidden by a block since): only the newer line stays.
    expect(mergeWhisperLines(cur, [], { replaceBefore: fetchedAt }).map((l) => l.id)).toEqual(["fresh"]);
  });

  it("fetches the room's own route", async () => {
    const paths: string[] = [];
    const get = async <T,>(p: string): Promise<T> => {
      paths.push(p);
      return { whispers: [] } as T;
    };
    expect(await fetchWhisperHistory("my room", get)).toEqual([]);
    expect(paths).toEqual(["/api/v1/rooms/my%20room/whispers"]);
  });
});
