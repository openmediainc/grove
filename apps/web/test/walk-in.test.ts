import { describe, expect, it } from "vitest";
import {
  FIRST_VISIT_KEY,
  WALK_IN_SEEN_KEY,
  autoWalkIn,
  describeArrival,
  mapCta,
  nameList,
  perceptionFromMe,
  readFlag,
  writeFlag,
  type FlagStore,
} from "@/lib/walk-in";

function memory(): FlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const throwing: FlagStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("the map's one call to action", () => {
  it("waits for /humans/me, then Sign in, then Walk in, then nothing", () => {
    expect(mapCta({ signedIn: null, inside: false, roomOpen: false })).toBeNull();
    expect(mapCta({ signedIn: false, inside: false, roomOpen: true })).toBe("sign-in");
    expect(mapCta({ signedIn: true, inside: false, roomOpen: false })).toBe("walk-in");
    expect(mapCta({ signedIn: true, inside: true, roomOpen: false })).toBeNull();
    expect(mapCta({ signedIn: true, inside: false, roomOpen: true })).toBeNull();
  });

  it("opens the walk-in sheet by itself once, only on a bare map", () => {
    const base = { signedIn: true as boolean | null, inside: false, seen: false, drawerOpen: false, kiosk: false };
    expect(autoWalkIn(base)).toBe(true);
    expect(autoWalkIn({ ...base, seen: true })).toBe(false);
    expect(autoWalkIn({ ...base, inside: true })).toBe(false);
    expect(autoWalkIn({ ...base, drawerOpen: true })).toBe(false);
    expect(autoWalkIn({ ...base, kiosk: true })).toBe(false);
    expect(autoWalkIn({ ...base, signedIn: null })).toBe(false);
    expect(autoWalkIn({ ...base, signedIn: false })).toBe(false);
  });
});

describe("remembered flags", () => {
  it("round-trip, and survive storage that throws", () => {
    const s = memory();
    expect(readFlag(s, FIRST_VISIT_KEY)).toBe(false);
    writeFlag(s, FIRST_VISIT_KEY);
    expect(readFlag(s, FIRST_VISIT_KEY)).toBe(true);
    expect(readFlag(s, WALK_IN_SEEN_KEY)).toBe(false);
    expect(readFlag(throwing, FIRST_VISIT_KEY)).toBe(false);
    expect(() => writeFlag(throwing, FIRST_VISIT_KEY)).not.toThrow();
    expect(readFlag(null, FIRST_VISIT_KEY)).toBe(false);
  });
});

describe("the arrival line", () => {
  const lantern = { actor_id: "a1", kind: "agent", display_name: "lantern", slug: "lantern" };
  const ada = { actor_id: "h1", kind: "human", display_name: "Ada", slug: "ada" };
  const me = { actor_id: "me", kind: "human", display_name: "Me", slug: "me" };

  it("never counts you among the people who can hear you", () => {
    expect(describeArrival([me], "me", { lurk: false, overhear: true })).toMatch(/first one in/);
  });

  it("says who can hear you, given the choices made", () => {
    expect(describeArrival([me, ada, lantern], "me", { lurk: false, overhear: true })).toBe("Ada and lantern can hear you. Say hello.");
    expect(describeArrival([ada, lantern], "me", { lurk: true, overhear: true })).toMatch(/You're lurking/);
    expect(describeArrival([lantern], "me", { lurk: false, overhear: false })).toMatch(/nothing you say reaches them/);
    expect(describeArrival([ada, lantern], "me", { lurk: false, overhear: false })).toBe(
      "Ada can hear you. lantern is here too, but you've asked agents not to hear you.",
    );
  });

  it("lists names the way a person would", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["a"])).toBe("a");
    expect(nameList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("starts the sheet from the viewer's own settings", () => {
    expect(perceptionFromMe({ lurk: true, privacy: { overhearable_by_agents: false } })).toEqual({ lurk: true, overhear: false });
    expect(perceptionFromMe({ privacy: { overhearableByAgents: false } })).toEqual({ lurk: false, overhear: false });
    expect(perceptionFromMe(null)).toEqual({ lurk: false, overhear: true });
  });
});
