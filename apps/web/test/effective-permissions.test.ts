import { describe, expect, it } from "vitest";
import {
  CAP_ORDER,
  cellReason,
  effectivePermissionsPath,
  placeRows,
  treeCeilings,
  type WireEffectivePermissions,
  type WireSpace,
  type WireVerdicts,
} from "../lib/effective-permissions";

const open = { allowed: true, ceiling_allows: true };
const all = (v: object): WireVerdicts =>
  Object.fromEntries(CAP_ORDER.map((c) => [c, v])) as WireVerdicts;
const listenOnly = { speak_to_agents: false, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true };

function space(over: Partial<WireSpace>): WireSpace {
  return {
    id: "w1",
    slug: "study",
    name: "Study",
    commons: false,
    preset: "public_write",
    member_policy: null,
    is_member: true,
    is_owner: true,
    here: false,
    verdicts: all(open),
    rooms: [],
    ...over,
  };
}

const wire: WireEffectivePermissions = {
  agent_id: "agt_1",
  policy: { speak_to_agents: true, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true },
  spaces: [
    space({ id: "aetheria-prime", slug: "aetheria-prime", name: "Aetheria", commons: true, is_owner: false }),
    space({
      id: "w1",
      preset: "private",
      member_policy: listenOnly,
      verdicts: {
        listen_to_humans: open,
        listen_to_agents: open,
        speak_to_humans: { allowed: false, source: "actor", ceiling_allows: false },
        speak_to_agents: { allowed: false, source: "space", membership: "member", ceiling_allows: false },
      },
      rooms: [
        {
          id: "w1:library",
          slug: "library",
          name: "Library",
          room_preset: "public_view",
          member_policy: null,
          here: false,
          verdicts: all(open),
        },
      ],
    }),
    space({
      id: "w2",
      slug: "gallery",
      name: "Gallery",
      preset: "public_view",
      is_member: false,
      is_owner: false,
      here: true,
      verdicts: {
        listen_to_humans: open,
        listen_to_agents: open,
        speak_to_humans: { allowed: false, source: "actor", ceiling_allows: false },
        speak_to_agents: { allowed: false, source: "space", membership: "non_member", ceiling_allows: false },
      },
      rooms: [
        {
          id: "w2:plaza",
          slug: "plaza",
          name: "Plaza",
          room_preset: null,
          member_policy: null,
          here: true,
          verdicts: {
            listen_to_humans: open,
            listen_to_agents: open,
            speak_to_humans: { allowed: false, source: "actor", ceiling_allows: false },
            speak_to_agents: { allowed: false, source: "space", membership: "non_member", ceiling_allows: false },
          },
        },
      ],
    }),
  ],
};

describe("placeRows", () => {
  it("leads with where the agent is, then the commons, rooms under their space", () => {
    const rows = placeRows(wire);
    expect(rows.map((r) => r.label)).toEqual(["Gallery", "Gallery · Plaza", "The commons", "Study", "Study · Library"]);
    expect(rows.map((r) => r.here)).toEqual([false, true, false, false, false]);
    expect(rows.filter((r) => r.isRoom).map((r) => r.key)).toEqual(["w2:plaza", "w1:library"]);
    expect(rows.find((r) => r.key === "w1")!.detail).toBe("Private · you are a member · members have their own limits");
    expect(rows.find((r) => r.key === "w2")!.detail).toBe("Watch only · your agent is a visitor");
  });

  it("says whose door closed each cell, in plain words", () => {
    const rows = placeRows(wire);
    const cell = (key: string, cap: string) => rows.find((r) => r.key === key)!.cells.find((c) => c.cap === cap)!;
    expect(cell("w2:plaza", "speak_to_agents")).toEqual({
      cap: "speak_to_agents",
      allowed: false,
      tone: "ceiling",
      // The room follows its space, so the space is named — not the room.
      reason: "Gallery is Watch only for visitors",
    });
    expect(cell("w2", "speak_to_humans")).toMatchObject({ tone: "yours", reason: "your setting: can't speak to humans (Gallery would not allow it either)" });
    expect(cell("w1", "speak_to_agents")).toMatchObject({ tone: "ceiling", reason: "even members can't speak to agents in Study" });
    expect(cell("aetheria-prime", "listen_to_humans")).toMatchObject({ tone: "open", reason: "the commons narrows nothing" });
    expect(rows.find((r) => r.key === "aetheria-prime")!.cells.map((c) => c.cap)).toEqual(CAP_ORDER);
  });

  it("names a room's own door by the room", () => {
    const c = cellReason(
      "speak_to_humans",
      { allowed: false, source: "room", membership: "non_member" },
      { name: "the Library", access: "public_view", commons: false, isMember: false, space: { name: "Study", access: "private" } },
    );
    expect(c.reason).toBe("the Library is Watch only for visitors");
    expect(cellReason("listen_to_agents", { allowed: false }, { name: "x", access: null, commons: false, isMember: false }).reason).toBe("not allowed here");
  });

  it("a lobby on a held plot is named by its room only, never a space name", () => {
    const held = space({ id: "w9", slug: null, name: null, preset: "private", is_member: false, is_owner: false, here: true, verdicts: all({ allowed: false, source: "space", membership: "non_member" }), rooms: [
      { id: "w9:garden", slug: "garden", name: "Garden", room_preset: "public_write", member_policy: null, here: true, verdicts: all(open) },
    ] });
    const rows = placeRows({ ...wire, spaces: [held] });
    expect(rows.map((r) => r.label)).toEqual(["Garden, a lobby on a held plot"]);
    expect(rows[0]!.cells[0]!.reason).toBe("the Garden lets visitors hear humans");
    expect(JSON.stringify(rows)).not.toMatch(/w9"|Private/);
  });

  it("renders nothing without data, and asks the owner-only route", () => {
    expect(placeRows(null)).toEqual([]);
    expect(effectivePermissionsPath("agt/../x")).toBe("/api/v1/agents/agt%2F..%2Fx/effective-permissions");
  });
});

describe("treeCeilings", () => {
  const directory = [
    { id: "commons", label: "The commons", preset: "public_write" as const, isMember: true },
    { id: "w1", label: "Study", preset: "private" as const, isMember: true },
    { id: "w2", label: "Gallery", preset: "public_view" as const, isMember: false },
    { id: "w3", label: "Plot 3", preset: "private" as const, isMember: false },
  ];

  it("gives the tree the member ceiling and each room with its own door", () => {
    const tree = treeCeilings(directory, wire);
    expect(tree.map((t) => t.id)).toEqual(["commons", "w1", "w1:library", "w2", "w3"]);
    expect(tree[1]!.memberPolicy).toEqual({ speakToAgents: false, speakToHumans: false, listenToAgents: true, listenToHumans: true });
    expect(tree[2]).toMatchObject({ label: "Study · Library", preset: "private", roomPreset: "public_view", isMember: true });
    expect(tree[4]).toEqual(directory[3]);
  });

  it("is the directory unchanged until the route answers", () => {
    expect(treeCeilings(directory, null)).toBe(directory);
  });
});
