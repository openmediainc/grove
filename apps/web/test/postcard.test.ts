import { describe, expect, it } from "vitest";
import {
  fitLine,
  nearestToCentre,
  postcardCaption,
  postcardClock,
  postcardFilename,
  type PostcardSubject,
} from "../lib/postcard";
import { THEMES, THEME_IDS } from "../lib/themes";

const AT = Date.UTC(2026, 8, 13, 14, 5, 42);
const aoe = THEMES.aoe.lexicon;

const scout: PostcardSubject = {
  name: "Scout",
  kind: "agent",
  region: "workshop",
  verb: "tool",
  detail: "Bash: pnpm test",
  followed: true,
};

describe("postcard caption", () => {
  it("names the world, the UTC hour and the sky in the theme's words", () => {
    const c = postcardCaption({ lex: aoe, at: AT });
    expect(c.title).toBe("Greetings from Aetheria");
    expect(c.when).toMatch(/^2026-09-13 14:05 UTC · .+ over Aetheria$/);
    expect(c.subject).toBeNull();
  });

  it("says what the followed body is doing, and where", () => {
    const c = postcardCaption({ lex: aoe, at: AT, subject: scout });
    expect(c.subject).toBe("Following Scout · An agent · tool: Bash: pnpm test · Workshop");
  });

  it("does not claim a follow for a body that is only mid-frame", () => {
    const c = postcardCaption({ lex: aoe, at: AT, subject: { ...scout, followed: false, kind: "human", verb: "say", detail: null } });
    expect(c.subject).toBe("Scout · A person · speaking · Workshop");
  });

  it("drops a detail that only repeats the verb, and never names a non-civic region", () => {
    const c = postcardCaption({ lex: aoe, at: AT, subject: { ...scout, region: "wild", verb: "idle", detail: "idle", followed: false } });
    expect(c.subject).toBe("Scout · An agent · idle");
  });

  it("never prints a private plot's name, even if a detail spells it", () => {
    const c = postcardCaption({
      lex: aoe,
      at: AT,
      subject: { ...scout, detail: "tidying the secret garden shed" },
      privateNames: ["Secret Garden"],
    });
    expect(c.subject).toBe("Following Scout · An agent · tool · Workshop");
    expect(JSON.stringify(c).toLowerCase()).not.toContain("secret garden");
  });

  it("tags a picture of the past with the replay word and the playhead's hour", () => {
    const c = postcardCaption({ lex: aoe, at: Date.UTC(2026, 8, 12, 3, 0), replay: true });
    expect(c.when.startsWith("Replay · 2026-09-12 03:00 UTC")).toBe(true);
  });

  it("has postcard words in every theme, in that theme's own voice", () => {
    for (const id of THEME_IDS) {
      const lex = THEMES[id].lexicon;
      const c = postcardCaption({ lex, at: AT, replay: true, subject: scout });
      expect(lex.postcard.button.length).toBeGreaterThan(0);
      expect(lex.postcard.buttonTitle).toMatch(/device/);
      expect(c.title).toBe(`${lex.postcard.greeting} ${lex.postcard.world}`);
      expect(c.when).toContain(lex.skyPlace);
      expect(c.when.startsWith(`${lex.postcard.replay} · `)).toBe(true);
      expect(c.subject).toContain(lex.anAgent);
      expect(c.subject).toContain(lex.regions.workshop.title);
    }
    expect(THEMES.space.lexicon.postcard.world).not.toBe(aoe.postcard.world);
  });

  it("clips a very long detail", () => {
    const c = postcardCaption({ lex: aoe, at: AT, subject: { ...scout, detail: "x".repeat(300) } });
    expect(c.subject!.length).toBeLessThan(140);
    expect(c.subject).toContain("…");
  });
});

describe("postcard helpers", () => {
  it("formats the clock and the filename in UTC", () => {
    expect(postcardClock(AT)).toBe("2026-09-13 14:05 UTC");
    expect(postcardFilename(AT)).toBe("grove-postcard-20260913-1405Z.png");
  });

  it("fits a line with an ellipsis", () => {
    const m = (s: string) => s.length;
    expect(fitLine("short", 10, m)).toBe("short");
    const fitted = fitLine("a much longer line of text", 10, m);
    expect(fitted.length).toBeLessThanOrEqual(10);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("picks the body nearest the middle, within reach", () => {
    const pts = [
      { id: "a", x: 100, y: 100 },
      { id: "b", x: 205, y: 198 },
      { id: "c", x: 400, y: 400 },
    ];
    expect(nearestToCentre(pts, 200, 200, 72)?.id).toBe("b");
    expect(nearestToCentre(pts, 700, 700, 72)).toBeNull();
  });
});
