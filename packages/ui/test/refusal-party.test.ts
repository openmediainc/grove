import { describe, expect, it } from "vitest";
import { CEILING_RECOURSE, describeRefusal } from "../src/refusal";

/** #62: a ceiling refusal about the OTHER side must not be told to the reader as their own. */
describe("describeRefusal with party", () => {
  const base = { code: "PERMISSION_DENIED", senderKind: "human" as const };

  it("a listener who is a visitor is 'they', not 'you'", () => {
    const r = describeRefusal({ ...base, capability: "listen_to_humans", source: "space", membership: "non_member", party: "recipient" });
    expect(r.headline).toBe("They are a visitor here, and visitors do not hear people here.");
    expect(r.recourse).toBe(CEILING_RECOURSE.theirVisit);
    expect(`${r.headline} ${r.recourse}`).not.toMatch(/\byou\b/i);
  });

  it("a members' ceiling on their ear sends nobody to join", () => {
    const r = describeRefusal({ ...base, capability: "listen_to_agents", source: "room", membership: "member", party: "recipient" });
    expect(r.headline).toMatch(/members included/);
    expect(r.recourse).toBe(CEILING_RECOURSE.member);
  });

  it("the sender's own ceiling, and an older server with no party, read exactly as before", () => {
    const input = { ...base, capability: "speak_to_humans", source: "room" as const, membership: "non_member" as const };
    const legacy = describeRefusal(input);
    expect(describeRefusal({ ...input, party: "sender" })).toEqual(legacy);
    expect(legacy.recourse).toBe(CEILING_RECOURSE.visitor);
  });

  it("an actor refusal with party but no subject still names the right person", () => {
    expect(describeRefusal({ ...base, capability: "speak_to_humans", source: "actor", party: "sender" }).headline).toBe(
      "Your own settings do not let you speak to people.",
    );
  });
});
