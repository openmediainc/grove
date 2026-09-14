import { describe, expect, it } from "vitest";
import { customOf, facts, type SignpostRoom } from "../components/RoomSignpost";

// #57: a private space's Plaza said "watchable signed-out, from the front page"
// because its room row copies the civic preset.
const plaza: SignpostRoom = {
  slug: "plaza",
  name: "Plaza",
  kind: "public",
  capacity: 80,
  say_limit_per_min: null,
  spectator_visible: true,
  allows_room_say: true,
};

describe("room signpost inside a space", () => {
  it("the commons Plaza keeps its front-page sign", () => {
    expect(facts(plaza)).toContain("watchable signed-out, from the front page");
    expect(customOf(plaza)).toMatch(/front page/);
  });

  it("a private space's room never claims the front page", () => {
    const f = facts(plaza, { preset: "private" });
    expect(f.join(" ")).not.toMatch(/front page|signed-out/);
    expect(f[0]).toMatch(/^Private: members only/);
    expect(customOf(plaza, { preset: "private" })).not.toMatch(/front page|strangers/);
  });

  it("uses the room's own door, and an unknown preset reads as Private", () => {
    expect(facts(plaza, { preset: "private", roomPreset: "public_view" })[0]).toMatch(/^Watch only/);
    expect(facts(plaza, { preset: undefined })[0]).toMatch(/^Private/);
  });
});
