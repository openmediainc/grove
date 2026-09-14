import { describe, expect, it } from "vitest";
import {
  BOARD_CAPTION_MAX,
  base64DecodedLength,
  formatBoardBytes,
  isBoardPostKind,
  readBoardCaption,
  readBoardLink,
  stripDataUrlPrefix,
} from "../src/board.js";

describe("board rules (#36)", () => {
  it("knows the three kinds", () => {
    expect(["image", "link", "text"].every(isBoardPostKind)).toBe(true);
    expect(isBoardPostKind("iframe")).toBe(false);
    expect(isBoardPostKind(undefined)).toBe(false);
  });

  it("trims captions, strips control characters and caps at 280 characters", () => {
    expect(readBoardCaption(undefined)).toEqual({ ok: true, value: null });
    expect(readBoardCaption("   ")).toEqual({ ok: true, value: null });
    expect(readBoardCaption(` hi${String.fromCharCode(7)} there\n\n\n\nok `)).toEqual({ ok: true, value: "hi there\n\nok" });
    expect(readBoardCaption(String.fromCodePoint(0x1f33f).repeat(BOARD_CAPTION_MAX)).ok).toBe(true);
    expect(readBoardCaption("a".repeat(BOARD_CAPTION_MAX + 1)).ok).toBe(false);
    expect(readBoardCaption(42).ok).toBe(false);
  });

  it("accepts only http(s) links without credentials, adding https to a bare host", () => {
    expect(readBoardLink("example.com/a#frag")).toEqual({ ok: true, value: "https://example.com/a" });
    expect(readBoardLink("http://example.com")).toEqual({ ok: true, value: "http://example.com/" });
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>", "file:///etc/passwd", "mailto:a@b.c", "https://u:p@example.com", "", "a b", 7]) {
      expect(readBoardLink(bad).ok).toBe(false);
    }
  });

  it("measures base64 without decoding and strips a data: prefix", () => {
    expect(base64DecodedLength(Buffer.alloc(5).toString("base64"))).toBe(5);
    expect(base64DecodedLength(Buffer.alloc(6).toString("base64"))).toBe(6);
    expect(stripDataUrlPrefix("data:image/png;base64,AAAA")).toBe("AAAA");
    expect(stripDataUrlPrefix("AAAA")).toBe("AAAA");
    expect(formatBoardBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBoardBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBoardBytes(900)).toBe("1 KB");
  });
});
