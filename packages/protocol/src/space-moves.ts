/**
 * Transfer & relocate (queue #35): the rules both the server and the Manage
 * tab read, so the confirmation the page gates on is the one the API checks
 * and the plots the page offers are the ones the API accepts.
 */
import { ringCapacity, ringsNeeded } from "./map-layout.js";
import { plotBlock, plotsAdjacent } from "./estates.js";

/** A pending hand-over runs out this long after it is offered. */
export const TRANSFER_EXPIRY_DAYS = 7;
/** A space moves plot at most once in this many days, so the map does not churn. */
export const RELOCATE_COOLDOWN_DAYS = 7;
/** How many plots the move picker offers. */
export const RELOCATE_OPTION_LIMIT = 12;

const DAY_MS = 86_400_000;

export type TransferStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

/**
 * The typed confirmation: the owner types the space's slug. Surrounding
 * whitespace is forgiven and case is not significant (slugs are lowercase), but
 * nothing else is — a prefix or a near miss does not confirm.
 */
export function confirmsSlug(typed: unknown, slug: string): boolean {
  if (typeof typed !== "string" || !slug) return false;
  return typed.trim().toLowerCase() === slug.trim().toLowerCase();
}

/** Chebyshev distance between two plots, in blocks. 1 = touching (sides or corners). */
export function plotDistance(a: number, b: number): number {
  const p = plotBlock(a);
  const q = plotBlock(b);
  return Math.max(Math.abs(p.bx - q.bx), Math.abs(p.by - q.by));
}

/**
 * The highest plot index (exclusive) a space may move to while `claimed` plots
 * are held: every ring the world already draws, which is the rings the claimed
 * plots need plus the one ring of open land beyond them (worldBounds). A move
 * never lands outside the drawn world.
 */
export function relocationIndexLimit(claimed: number): number {
  const outer = Math.max(2, ringsNeeded(Math.max(1, claimed)) + 1);
  let n = 0;
  for (let r = 2; r <= outer; r++) n += ringCapacity(r);
  return n;
}

export interface RelocationOption {
  plotIndex: number;
  /** Shares an edge with one of the anchor plots, so the two would join as an estate (#37). */
  near: boolean;
  /** The anchor it touches, when near. */
  nextTo: number | null;
}

/**
 * Free plots to offer for a move. Plots sharing an edge with one of `anchors`
 * (the holder's other plots) come first, lowest index first; then the lowest free indices,
 * so the world stays compact. `taken` must include the space's own plot.
 */
export function relocationOptions(input: {
  taken: Iterable<number>;
  current: number;
  claimed: number;
  anchors?: Iterable<number>;
  limit?: number;
}): RelocationOption[] {
  const taken = new Set(input.taken);
  taken.add(input.current);
  const anchors = [...new Set(input.anchors ?? [])].filter((a) => a !== input.current && a >= 0);
  const max = relocationIndexLimit(input.claimed);
  const limit = Math.max(0, input.limit ?? RELOCATE_OPTION_LIMIT);
  const near: RelocationOption[] = [];
  const rest: RelocationOption[] = [];
  for (let i = 0; i < max; i++) {
    if (taken.has(i)) continue;
    const touching = anchors.find((a) => plotsAdjacent(i, a));
    if (touching !== undefined) near.push({ plotIndex: i, near: true, nextTo: touching });
    else rest.push({ plotIndex: i, near: false, nextTo: null });
  }
  const out = [...near, ...rest];
  return out.slice(0, limit);
}

/** Whether `target` is a plot this space may move to. Null when it may, else the reason. */
export function relocationRefusal(input: {
  target: unknown;
  current: number | null;
  claimed: number;
  relocatedAt: string | Date | null;
  now?: number;
}): string | null {
  if (input.current === null) return "The commons can't move.";
  const t = input.target;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 0) return "Pick a plot to move to.";
  if (t === input.current) return "The space is already on that plot.";
  if (t >= relocationIndexLimit(input.claimed)) return "That plot is outside the world as it is drawn today.";
  const next = nextRelocationAt(input.relocatedAt);
  if (next && next.getTime() > (input.now ?? Date.now())) {
    return `A space can move once a week. This one can move again after ${next.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  }
  return null;
}

/** When a space that last moved at `relocatedAt` may move again. Null = now. */
export function nextRelocationAt(relocatedAt: string | Date | null): Date | null {
  if (!relocatedAt) return null;
  const t = new Date(relocatedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + RELOCATE_COOLDOWN_DAYS * DAY_MS);
}

/** When an offer made at `createdAt` runs out. */
export function transferExpiresAt(createdAt: Date | number = Date.now()): Date {
  return new Date(new Date(createdAt).getTime() + TRANSFER_EXPIRY_DAYS * DAY_MS);
}
