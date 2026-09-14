import { COLORS } from "@grove/ui/tokens";

/**
 * People vs agents at a glance (DECISIONS #7, DESIGN.md §1.4).
 *
 * Amber is a person, cyan is an agent. Two places use it:
 *
 *   chrome   a chip or tick beside a name (peek cards, rosters, search, the
 *            transcript), in the `human` / `agent` brand tokens, so day mode
 *            gets the contrast-safe #8A5200 / #0A6680 and night the Nightwatch
 *            #F4B860 / #7FD1E8 without the component knowing which is on.
 *   canvas   a small theme-invariant tick after a nameplate on the map. The
 *            map ground can be any theme's colour at any hour, so the tick is
 *            drawn in the NIGHT values on a dark backing, which reads on all of
 *            them. It never replaces a verb ring, hazard or outcome mark: it is
 *            smaller, sits after the name, and is a different shape for each
 *            kind (a dot for a person, a diamond for an agent), so colour is
 *            never the only signal.
 */

export type IdentityKind = "human" | "agent";

/** A Paperclip body is somebody's agent run elsewhere: it ticks as an agent. */
export function identityOf(kind: string | null | undefined): IdentityKind {
  return kind === "human" ? "human" : "agent";
}

/** The word a screen reader hears, and the one a tooltip shows. */
export function identityWord(kind: IdentityKind): string {
  return kind === "human" ? "Person" : "Agent";
}

/** Canvas colours: Nightwatch amber and cyan on night glass, whatever the theme. */
export const IDENTITY_TICK = {
  human: COLORS.night.human,
  agent: COLORS.night.agent,
  backing: "rgba(10, 11, 20, 0.82)",
  keyline: "rgba(228, 226, 240, 0.28)",
} as const;

/** How much room the tick takes after a name, in CSS pixels (gap + backing). */
export const IDENTITY_TICK_W = 10;

type TickCtx = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "arc" | "fill" | "stroke" | "fillStyle" | "strokeStyle" | "lineWidth"
>;

/**
 * Draw the tick centred on (cx, cy) in screen pixels: a 9px dark disc with a
 * faint keyline, and inside it a 5px amber dot (person) or cyan diamond
 * (agent). Pure drawing, no state.
 */
export function drawIdentityTick(ctx: TickCtx, cx: number, cy: number, kind: IdentityKind): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = IDENTITY_TICK.backing;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = IDENTITY_TICK.keyline;
  ctx.stroke();
  ctx.fillStyle = IDENTITY_TICK[kind];
  ctx.beginPath();
  if (kind === "human") {
    ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  } else {
    ctx.moveTo(cx, cy - 3);
    ctx.lineTo(cx + 3, cy);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - 3, cy);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

/** The tick as a chrome class: colour from the brand token, shape by kind. */
export function identityTickClass(kind: IdentityKind): string {
  return kind === "human"
    ? "inline-block h-2 w-2 shrink-0 rounded-full bg-human"
    : "inline-block h-2 w-2 shrink-0 rotate-45 rounded-[1px] bg-agent";
}

/** Text in the identity colour (safe as text in every mode, DESIGN.md §3). */
export function identityTextClass(kind: IdentityKind): string {
  return kind === "human" ? "text-human" : "text-agent";
}
