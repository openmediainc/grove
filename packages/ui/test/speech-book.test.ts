import { describe, expect, it } from "vitest";
import { SPEECH_KEEP_CHARS, SpeechBook } from "../src/speech-book";

describe("SpeechBook", () => {
  it("keeps the newest line per speaker", () => {
    const b = new SpeechBook();
    b.hear("a", "first", 1000);
    b.hear("a", "second", 2000);
    b.hear("a", "late arrival of an older line", 1500);
    expect(b.get("a")?.text).toBe("second");
  });

  it("seeds oldest-first lists so the last line wins, and keeps times stable across re-seeds", () => {
    const b = new SpeechBook();
    const recent = [
      { actorId: "a", text: "one" },
      { actorId: "b", text: "two" },
      { actorId: "a", text: "three" },
    ];
    b.seed(recent, 100_000);
    expect(b.get("a")?.text).toBe("three");
    const atA = b.get("a")!.at;
    const atB = b.get("b")!.at;
    expect(atA).toBeGreaterThan(atB);
    b.seed(recent, 108_000);
    expect(b.get("a")!.at).toBe(atA);
    expect(b.get("b")!.at).toBe(atB);
  });

  it("never lets a seed overwrite a newer live line", () => {
    const b = new SpeechBook();
    b.hear("a", "live", 100_000);
    b.seed([{ actorId: "a", text: "old" }], 100_500);
    expect(b.get("a")?.text).toBe("live");
  });

  it("prunes absent speakers and stale lines", () => {
    const b = new SpeechBook();
    b.hear("a", "x", 0);
    b.hear("b", "y", 9_000);
    b.hear("c", "z", 9_000);
    b.prune(new Set(["a", "b"]), 5_000, 10_000);
    expect(b.get("a")).toBeUndefined();
    expect(b.get("b")?.text).toBe("y");
    expect(b.get("c")).toBeUndefined();
  });

  it("clips long lines and marks whispers", () => {
    const b = new SpeechBook();
    b.hear("a", "x".repeat(500), 1, true);
    expect(b.get("a")?.text.length).toBe(SPEECH_KEEP_CHARS);
    expect(b.get("a")?.whisper).toBe(true);
  });
});
