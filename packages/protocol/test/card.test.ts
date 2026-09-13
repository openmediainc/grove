import { describe, expect, it } from "vitest";
import {
  CARD_LINKS_MAX,
  CARD_TEXT_MAX,
  isEmptyCard,
  mergeCard,
  normaliseCardLink,
  normaliseCardPatch,
  readStoredCard,
} from "../src/card.js";

describe("card links", () => {
  it("keeps an http(s) link and labels it by host when unlabelled", () => {
    expect(normaliseCardLink({ url: "https://example.com/repo" })).toEqual({ label: "example.com", url: "https://example.com/repo" });
    expect(normaliseCardLink({ url: "http://x.dev", label: "  Docs \n" })).toEqual({ label: "Docs", url: "http://x.dev/" });
  });

  it("refuses other schemes, credentials and junk", () => {
    expect(normaliseCardLink({ url: "javascript:alert(1)" })).toBeNull();
    expect(normaliseCardLink({ url: "data:text/html,hi" })).toBeNull();
    expect(normaliseCardLink({ url: "https://user:pw@example.com" })).toBeNull();
    expect(normaliseCardLink({ url: "not a url" })).toBeNull();
    expect(normaliseCardLink("https://example.com")).toBeNull();
  });
});

describe("who may write which field", () => {
  it("lets a space owner write all four", () => {
    const r = normaliseCardPatch(
      { workingOn: "a harbour", lookingFor: "a cartographer", latest: "opened the gate", links: [{ url: "https://a.b" }] },
      "space",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.patch).sort()).toEqual(["latest", "links", "lookingFor", "workingOn"]);
  });

  it("refuses an owner typing an agent's working on or latest, by name", () => {
    const a = normaliseCardPatch({ workingOn: "totally busy" }, "agent");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.message).toMatch(/fill themselves/);
    expect(normaliseCardPatch({ latest: "x" }, "agent").ok).toBe(false);
    expect(normaliseCardPatch({ lookingFor: "reviewers" }, "agent")).toEqual({ ok: true, patch: { lookingFor: "reviewers" } });
  });

  it("clears on null or blank, caps long text, strips secrets", () => {
    const r = normaliseCardPatch({ lookingFor: "", latest: null, workingOn: "long words ".repeat(60) }, "human");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.lookingFor).toBeNull();
    expect(r.patch.latest).toBeNull();
    expect(r.patch.workingOn!.length).toBe(CARD_TEXT_MAX);
    const s = normaliseCardPatch({ workingOn: "deploy with token=abc123secret" }, "human");
    expect(s.ok && s.patch.workingOn).toBe("deploy with token=…");
  });

  it("refuses too many links, a bad link, non-text and an empty write", () => {
    const many = Array.from({ length: CARD_LINKS_MAX + 1 }, (_, i) => ({ url: `https://e.com/${i}` }));
    expect(normaliseCardPatch({ links: many }, "space").ok).toBe(false);
    expect(normaliseCardPatch({ links: [{ url: "ftp://e.com" }] }, "space").ok).toBe(false);
    expect(normaliseCardPatch({ lookingFor: 42 }, "space").ok).toBe(false);
    expect(normaliseCardPatch({}, "agent").ok).toBe(false);
    expect(normaliseCardPatch({ links: null }, "space")).toEqual({ ok: true, patch: { links: [] } });
  });
});

describe("stored cards", () => {
  it("reads either spelling, drops bad links, and treats junk as empty", () => {
    const c = readStoredCard({ looking_for: "help", links: [{ url: "https://ok.dev" }, { url: "javascript:x" }] });
    expect(c).toEqual({ workingOn: null, lookingFor: "help", latest: null, links: [{ label: "ok.dev", url: "https://ok.dev/" }] });
    expect(isEmptyCard(readStoredCard(null))).toBe(true);
    expect(isEmptyCard(readStoredCard("nope"))).toBe(true);
  });

  it("merges a patch over what is stored, keeping links unless replaced", () => {
    const stored = readStoredCard({ lookingFor: "a", links: [{ url: "https://k.dev" }] });
    expect(mergeCard(stored, { lookingFor: "b" }).links).toHaveLength(1);
    expect(mergeCard(stored, { links: [] }).links).toHaveLength(0);
    expect(mergeCard(stored, { lookingFor: null }).lookingFor).toBeNull();
  });
});
