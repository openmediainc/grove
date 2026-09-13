import { describe, expect, it } from "vitest";
import { cardApiPath, cardRows, cardSavePath, draftFrom, draftToBody, walkOverTarget, type WireCard } from "../lib/card";
import { THEMES } from "../lib/themes";

const lex = THEMES.aoe.lexicon.card;

function wire(over: Partial<WireCard["card"]> = {}, sources: WireCard["sources"] = { working_on: null, latest: null }): WireCard {
  return {
    subject: "agent",
    slug: "scout",
    name: "Scout",
    card: { working_on: null, looking_for: null, latest: null, links: [], ...over },
    sources,
    latest_at: null,
    editable: [],
  };
}

describe("card paths", () => {
  it("asks the right route and never lets a slug climb out of it", () => {
    expect(cardApiPath({ subject: "space", ref: "harbour" })).toBe("/api/v1/cards/spaces/harbour");
    expect(cardApiPath({ subject: "agent", slug: "hello/claude" })).toBe("/api/v1/cards/agents/hello/claude");
    expect(cardApiPath({ subject: "human", slug: "../ops" })).toBe("/api/v1/cards/humans/..%2Fops");
    expect(cardSavePath("space", "w_1")).toBe("/api/v1/worlds/w_1/card");
    expect(cardSavePath("agent", "ag_1")).toBe("/api/v1/agents/ag_1/card");
    expect(cardSavePath("human", "anything")).toBe("/api/v1/humans/me/card");
  });
});

describe("card rows", () => {
  it("shows filled rows in order and says where a reading came from", () => {
    const rows = cardRows(wire({ latest: "Bash · 2s · done", working_on: "Edit · x.ts · running" }, { working_on: "span", latest: "span" }), lex);
    expect(rows.map((r) => r.field)).toEqual(["workingOn", "latest"]);
    expect(rows[0]!.hint).toBe(lex.fromToolCalls);
    expect(cardRows(wire({ working_on: "reading" }, { working_on: "pulse", latest: null }), lex)[0]!.hint).toBe(lex.fromPulse);
    expect(cardRows(wire({ looking_for: "reviewers" }, { working_on: "owner", latest: "owner" }), lex)[0]!.hint).toBeNull();
    expect(cardRows(wire(), lex)).toEqual([]);
  });

  it("has card words in every theme", () => {
    for (const t of Object.values(THEMES)) {
      for (const v of Object.values(t.lexicon.card)) expect(v.length).toBeGreaterThan(0);
    }
  });
});

describe("walk over", () => {
  it("walks a body into its room, asking a spectator to sign in first", () => {
    expect(walkOverTarget({ kind: "body", room: "workshop" }, true)).toEqual({ path: "/?room=workshop", needsLogin: false });
    expect(walkOverTarget({ kind: "body", room: "workshop" }, false)).toEqual({ path: "/?room=workshop", needsLogin: true });
    // Still finding out: the room page itself will ask.
    expect(walkOverTarget({ kind: "body", room: "plaza" }, null).needsLogin).toBe(false);
  });

  it("walks to a space's page, where its own door decides", () => {
    expect(walkOverTarget({ kind: "space", slug: "harbour" }, false)).toEqual({ path: "/s/harbour", needsLogin: false });
  });
});

describe("the edit form", () => {
  it("sends only what the subject writes, blanks as clears, and drops empty links", () => {
    const d = draftFrom(wire({ looking_for: "reviewers", links: [{ label: "Repo", url: "https://e.com/" }] }));
    d.workingOn = "sneaky";
    d.links.push({ label: "", url: "  " });
    expect(draftToBody("agent", d)).toEqual({ looking_for: "reviewers", links: [{ label: "Repo", url: "https://e.com/" }] });
    d.lookingFor = "   ";
    expect(draftToBody("space", d)).toMatchObject({ working_on: "sneaky", looking_for: null, latest: null });
  });
});
