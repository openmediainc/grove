/**
 * "Bring your agent" on the map: the paste-this line, for the people who have
 * not brought one yet. Pure, so the show/hide rules are testable without a
 * browser (test/bring-agent.test.ts).
 *
 * The line is fixed on purpose: it is what somebody pastes into a different
 * program, so it names the public address, never the origin this page happens
 * to be served from (a preview, localhost).
 */

/** Exactly what Copy puts on the clipboard. */
export const BRING_AGENT_LINE = "Read https://glasshouse.rendrr.app/skill.md and follow it to join Glasshouse.";

/** The heading and lead-in, as one plain sentence pair. */
export const BRING_AGENT_TITLE = "Bring your agent.";
export const BRING_AGENT_LEAD = "Paste this into any agent:";

/** How it works, at its "Bring an agent" section (app/how-it-works, section id="bring"). */
export const BRING_AGENT_HOW_HREF = "/how-it-works#bring";

/** localStorage: "1" once the card is closed in this browser. It never comes back there. */
export const BRING_AGENT_DISMISSED_KEY = "glasshouse-byoa-dismissed";

export type BringAgentState = {
  /** null until /humans/me has answered. */
  signedIn: boolean | null;
  /** Whether the signed-in viewer owns at least one agent. null while unknown (or signed out). */
  ownsAgent: boolean | null;
  /** Closed before in this browser. */
  dismissed: boolean;
  /** A room or history drawer is open: the card never sits over it. */
  drawerOpen: boolean;
  /** A map panel the viewer opened (Record a shot, Legend, Keyboard): it waits, never on top. */
  panelOpen: boolean;
  /** Kiosk, TV or a playing sequence: no chrome at all. */
  bare: boolean;
};

/**
 * Whether the card shows.
 *   closed in this browser           → never again
 *   drawer or panel open, kiosk, TV,
 *   cinema                           → not now
 *   session not known yet            → not yet (so it never flashes for an owner)
 *   signed out                       → yes
 *   signed in, owns an agent         → no
 *   signed in, owns none             → yes, once that is known
 */
export function bringAgentVisible(s: BringAgentState): boolean {
  if (s.dismissed || s.drawerOpen || s.panelOpen || s.bare) return false;
  if (s.signedIn === null) return false;
  if (!s.signedIn) return true;
  return s.ownsAgent === false;
}

/** Owned agents off GET /api/v1/studio/agents → whether the viewer already has one. */
export function ownsAnAgent(res: { agents?: unknown[] | null } | null | undefined): boolean {
  return Array.isArray(res?.agents) && res!.agents!.length > 0;
}
