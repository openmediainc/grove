/**
 * Preview before claiming (queue #48): the pure half.
 *
 * Create space shows the plot a new space WOULD get, its sign, branding and
 * access, on a small read-only map, before anything is written. Nothing is
 * reserved: the plot is only the smallest free index at the moment of asking,
 * the same rule `CampusService.createWorld()` applies inside its INSERT, so a
 * claim that lands first can move it.
 *
 * What a preview may carry is public map data and nothing more: a neighbouring
 * private plot is a held plot (its index and access level, both already on the
 * public minimap) with no name, owner, orgs or branding.
 */
import { plotBlock } from "./estates.js";
import type { SpaceBranding } from "./branding.js";

/** The smallest plot index nobody holds. Mirrors the SQL allocator in createWorld(). */
export function nextFreePlotIndex(taken: Iterable<number>): number {
  const held = new Set<number>();
  for (const t of taken) if (Number.isInteger(t) && t >= 0) held.add(t);
  let i = 0;
  while (held.has(i)) i += 1;
  return i;
}

/**
 * Held plots whose block touches the target's (the eight around it), inside
 * out by index. The target itself is never its own neighbour.
 */
export function plotNeighbourhood(target: number, taken: Iterable<number>): number[] {
  const t = plotBlock(target);
  const out = new Set<number>();
  for (const i of taken) {
    if (!Number.isInteger(i) || i < 0 || i === target) continue;
    const b = plotBlock(i);
    if (Math.max(Math.abs(b.bx - t.bx), Math.abs(b.by - t.by)) <= 1) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export interface ClaimPreviewNeighbour {
  plotIndex: number;
  policyPreset: string;
  /** Null on a private plot. */
  name: string | null;
  orgs: Array<{ name: string; colour: string }>;
  /** Null on a private plot. */
  branding: SpaceBranding | null;
}

export interface ClaimPreview {
  /** The plot a space created right now would get. Not reserved. */
  plotIndex: number;
  /** Its block ring (districts.ts names it). */
  ring: number;
  neighbours: ClaimPreviewNeighbour[];
}

/**
 * One neighbouring plot, as a preview may show it. A private plot keeps only
 * what the public minimap already says: that it is held, where, and closed.
 */
export function redactNeighbour(row: {
  plotIndex: number;
  policyPreset: string;
  name: string | null;
  orgs?: ReadonlyArray<{ name: string; colour: string }> | null;
  branding?: SpaceBranding | null;
}): ClaimPreviewNeighbour {
  if (row.policyPreset === "private") {
    return { plotIndex: row.plotIndex, policyPreset: "private", name: null, orgs: [], branding: null };
  }
  return {
    plotIndex: row.plotIndex,
    policyPreset: row.policyPreset,
    name: row.name,
    orgs: (row.orgs ?? []).map((o) => ({ name: o.name, colour: o.colour })),
    branding: row.branding ?? null,
  };
}
