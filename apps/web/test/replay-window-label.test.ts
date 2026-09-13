import { describe, expect, it } from "vitest";
import { replayWindowLabel } from "../lib/replay/controller";

const at = (iso: string) => Date.parse(iso);

describe("replayWindowLabel", () => {
  const now = at("2026-09-13T14:49:30Z");

  it("dates both ends of a window that crosses UTC midnight, so a day never reads as a minute", () => {
    expect(replayWindowLabel(at("2026-09-12T14:49:00Z"), at("2026-09-13T14:49:00Z"), now)).toBe(
      "Sept 12 14:49–Sept 13 14:49",
    );
  });

  it("keeps a same-day window short", () => {
    expect(replayWindowLabel(at("2026-09-13T13:49:00Z"), at("2026-09-13T14:49:00Z"), now)).toBe("13:49–14:49");
  });
});
