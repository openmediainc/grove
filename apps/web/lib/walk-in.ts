/**
 * Walking in, and the map's one call to action.
 *
 * The walk-in sheet replaced the `/enter` page: the same two choices (Lurk,
 * Agents may hear me) and the same `POST /world/enter`, asked on the map, with
 * the room you land in opening as a drawer. Pure, so the arrival sentence, the
 * CTA's state machine and the remembered flags are testable without a browser.
 */

/** Remembered once a signed-in viewer has seen the walk-in sheet (shown once after sign-in). */
export const WALK_IN_SEEN_KEY = "glasshouse-walkin-seen";
/** Remembered once the first-visit card is dismissed. */
export const FIRST_VISIT_KEY = "glasshouse-first-visit-dismissed";

/** Just enough of localStorage; every call is wrapped because it can throw. */
export type FlagStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function readFlag(store: FlagStore | null | undefined, key: string): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(store: FlagStore | null | undefined, key: string): void {
  try {
    store?.setItem(key, "1");
  } catch {
    /* private mode: the card comes back next visit, which is harmless */
  }
}

/** The browser's localStorage, or null where touching it throws. */
export function browserStore(): FlagStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The map's single call to action.
 *   signed out            → Sign in
 *   signed in, no body    → Walk in
 *   standing in a room,
 *   or a room drawer open → nothing (the drawer is where you act)
 * Nothing at all until /humans/me has answered, so it never flashes the wrong one.
 */
export type MapCta = "sign-in" | "walk-in" | null;

export function mapCta(s: { signedIn: boolean | null; inside: boolean; roomOpen: boolean }): MapCta {
  if (s.signedIn === null) return null;
  if (!s.signedIn) return "sign-in";
  if (s.inside || s.roomOpen) return null;
  return "walk-in";
}

/** Whether the walk-in sheet opens by itself: once, for a signed-in viewer with no body, on a bare map. */
export function autoWalkIn(s: {
  signedIn: boolean | null;
  inside: boolean;
  seen: boolean;
  drawerOpen: boolean;
  kiosk: boolean;
}): boolean {
  return s.signedIn === true && !s.inside && !s.seen && !s.drawerOpen && !s.kiosk;
}

/** "lantern", "lantern and ivy", "lantern, ivy and spark". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type ArrivalBody = { actor_id: string; kind: string; display_name?: string | null; slug: string };

/** Who is actually in the room you landed in, and whether they can hear you. */
export function describeArrival(
  nearby: ArrivalBody[],
  meId: string | null,
  choice: { lurk: boolean; overhear: boolean },
): string {
  const others = nearby.filter((n) => n.actor_id !== meId);
  const name = (n: ArrivalBody) => n.display_name || n.slug;
  if (others.length === 0) {
    return "Nobody's here yet — you're the first one in. Say something and whoever arrives next will find it waiting.";
  }
  const names = nameList(others.map(name));
  const agents = others.filter((n) => n.kind === "agent");
  const verb = others.length === 1 ? "is" : "are";
  if (choice.lurk) {
    return `${names} ${verb} here. You're lurking, so you can hear them — they can't address you.`;
  }
  if (!choice.overhear && agents.length === others.length) {
    return `${names} ${verb} here, but you've asked agents not to hear you — nothing you say reaches them.`;
  }
  if (!choice.overhear && agents.length > 0) {
    const humans = nameList(others.filter((n) => n.kind !== "agent").map(name));
    return `${humans} can hear you. ${nameList(agents.map(name))} ${
      agents.length === 1 ? "is" : "are"
    } here too, but you've asked agents not to hear you.`;
  }
  return `${names} can hear you. Say hello.`;
}

/** The viewer's current perception settings off /humans/me, either wire casing. */
export function perceptionFromMe(human: unknown): { lurk: boolean; overhear: boolean } {
  const h = (human ?? {}) as {
    lurk?: unknown;
    privacy?: { overhearable_by_agents?: unknown; overhearableByAgents?: unknown } | null;
  };
  const o = h.privacy?.overhearable_by_agents ?? h.privacy?.overhearableByAgents;
  return { lurk: h.lurk === true, overhear: o === false ? false : true };
}
