import { describe, expect, it } from "vitest";
import {
  followApiPath,
  followTargetFromCard,
  heartLabel,
  noticeHref,
  noticeText,
  type WireFollowNotice,
} from "../lib/follow";
import { THEMES } from "../lib/themes";

const lex = THEMES.aoe.lexicon.card;

function notice(over: Partial<WireFollowNotice> = {}): WireFollowNotice {
  return {
    id: "fnt_1",
    kind: "agent.long_tool_call",
    payload: {
      subject: { kind: "agent", slug: "org/scout", name: "Scout" },
      room_id: "workshop",
      tool: { name: "Bash", outcome: "ok", duration_ms: 125_000 },
    },
    created_at: "2026-09-13T12:00:00Z",
    read_at: null,
    ...over,
  };
}

describe("the heart", () => {
  it("asks the right route and never lets a slug climb out of it", () => {
    expect(followApiPath({ subject: "space", ref: "harbour" })).toBe("/api/v1/follows/spaces/harbour");
    expect(followApiPath({ subject: "space", ref: "../x" })).toBe("/api/v1/follows/spaces/..%2Fx");
    expect(followApiPath({ subject: "agent", slug: "org/scout one" })).toBe("/api/v1/follows/agents/org/scout%20one");
  });

  it("is offered on spaces and agents, never on a person", () => {
    expect(followTargetFromCard({ subject: "agent", slug: "scout" })).toEqual({ subject: "agent", slug: "scout" });
    expect(followTargetFromCard({ subject: "space", ref: "harbour" })).toEqual({ subject: "space", ref: "harbour" });
    expect(followTargetFromCard({ subject: "human", slug: "ada" })).toBeNull();
    expect(followTargetFromCard(null)).toBeNull();
  });

  it("says follow or following in the theme's words, with a count when there is one", () => {
    expect(heartLabel(null, lex)).toBe("Follow");
    expect(heartLabel({ following: false, followers: 0 }, lex)).toBe("Follow");
    expect(heartLabel({ following: true, followers: 3 }, lex)).toBe("Following · 3");
    for (const theme of Object.values(THEMES)) {
      expect(theme.lexicon.card.follow).toBeTruthy();
      expect(theme.lexicon.card.following).toBeTruthy();
    }
  });

  it("links a notice to its subject and reads it as one sentence", () => {
    expect(noticeHref(notice())).toBe("/chronicle?actor=org%2Fscout");
    expect(noticeText(notice())).toBe("Scout finished Bash after 2m 5s.");
    const stage = notice({
      kind: "space.stage_started",
      payload: {
        subject: { kind: "space", slug: "the hall", name: "The Hall" },
        room_id: "wld_1:stage",
        stage: { title: "Open mic", starts_at: "2026-09-13T20:00:00Z", ends_at: null },
      },
    });
    expect(noticeHref(stage)).toBe("/spaces/the%20hall");
    expect(noticeText(stage)).toBe("The Hall opened a stage event: Open mic.");
    expect(noticeText(notice({ kind: "agent.gossip" }))).toBeNull();
  });
});
