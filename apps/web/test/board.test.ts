import { describe, expect, it } from "vitest";
import { authorHref, captionLeft, cardAccent, draftBody, draftProblem, imageFileProblem, postedAgo, safeHref } from "@/lib/board";

describe("space board composer and cards (#36)", () => {
  it("refuses a file that is not one of the four image types or is over 2 MB", () => {
    expect(imageFileProblem({ type: "image/png", size: 1000 })).toBeNull();
    expect(imageFileProblem({ type: "image/svg+xml", size: 100 })).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(imageFileProblem({ type: "image/jpeg", size: 3 * 1024 * 1024 })).toMatch(/at most 2 MB; that one is 3 MB/);
  });

  it("gates Post on the kind's own requirement and the caption length", () => {
    const base = { caption: "", url: "", hasImage: false };
    expect(draftProblem({ ...base, kind: "text" })).toMatch(/Write something/);
    expect(draftProblem({ ...base, kind: "text", caption: "shipped" })).toBeNull();
    expect(draftProblem({ ...base, kind: "image" })).toMatch(/Pick an image/);
    expect(draftProblem({ ...base, kind: "image", hasImage: true })).toBeNull();
    expect(draftProblem({ ...base, kind: "link", url: "javascript:alert(1)" })).toMatch(/http and https/);
    expect(draftProblem({ ...base, kind: "link", url: "example.com" })).toBeNull();
    expect(draftProblem({ ...base, kind: "text", caption: "x".repeat(281) })).toMatch(/280/);
    expect(captionLeft("  abc  ")).toBe(277);
  });

  it("sends only what the kind needs", () => {
    expect(draftBody({ kind: "link", caption: " see ", url: " https://a.test ", hasImage: false }, null)).toEqual({
      kind: "link",
      caption: "see",
      url: "https://a.test",
    });
    expect(draftBody({ kind: "image", caption: "", url: "ignored", hasImage: true }, "AQID")).toEqual({ kind: "image", image_base64: "AQID" });
  });

  it("only lets a strict hex colour and an http(s) href reach the card", () => {
    const p = { host: "a.test", title: null, description: null, theme_colour: "red;background:url(x)", favicon_colour: "#5EEAD4" };
    expect(cardAccent(p)).toBe("#5eead4");
    expect(cardAccent({ ...p, favicon_colour: null })).toBeNull();
    expect(cardAccent(null)).toBeNull();
    expect(safeHref("https://a.test/x")).toBe("https://a.test/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("links authors to their pages and words times plainly", () => {
    expect(authorHref({ id: "agt_1", kind: "agent", name: "Moss", handle: "moss" })).toBe("/a/moss");
    expect(authorHref({ id: "hum_1", kind: "human", name: "Ana", handle: "ana" })).toBe("/u/ana");
    expect(authorHref({ id: "hum_1", kind: "human", name: "Ana", handle: null })).toBeNull();
    const now = Date.parse("2026-09-13T12:00:00Z");
    expect(postedAgo("2026-09-13T11:59:30Z", now)).toBe("just now");
    expect(postedAgo("2026-09-13T11:15:00Z", now)).toBe("45 min ago");
    expect(postedAgo("2026-09-13T02:00:00Z", now)).toBe("10 h ago");
    expect(postedAgo("2026-09-10T12:00:00Z", now)).toBe("3 d ago");
    expect(postedAgo("2026-08-01T12:00:00Z", now)).toBe("2026-08-01");
  });
});
