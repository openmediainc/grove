import { describe, expect, it } from "vitest";
import { BOARD_IMAGE_MAX_AGE, boardImageCacheControl, boardImageVersion } from "../src/index.js";

describe("board image caching (#53)", () => {
  it("is private always: short revalidation for public images, no-store otherwise", () => {
    expect(BOARD_IMAGE_MAX_AGE).toBeLessThanOrEqual(300);
    expect(boardImageCacheControl("revalidate")).toBe(`private, max-age=${BOARD_IMAGE_MAX_AGE}, must-revalidate`);
    expect(boardImageCacheControl("no-store")).toBe("private, no-store");
    for (const c of ["revalidate", "no-store"] as const) expect(boardImageCacheControl(c)).not.toMatch(/public|s-maxage/);
  });

  it("changes the URL version when moderation changes the post", () => {
    const sha = "a".repeat(64);
    const visible = boardImageVersion(sha, false, null);
    const hidden = boardImageVersion(sha, true, "2026-09-13T10:00:00Z");
    const hiddenAgain = boardImageVersion(sha, true, "2026-09-13T11:00:00Z");
    expect(visible).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set([visible, hidden, hiddenAgain]).size).toBe(3);
    expect(boardImageVersion(sha, false, null)).toBe(visible);
    expect(boardImageVersion("b".repeat(64), false, null)).not.toBe(visible);
  });
});
