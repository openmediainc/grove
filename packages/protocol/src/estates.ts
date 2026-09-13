/**
 * Estates (queue #37): one owner's or one org's plots that sit side by side on
 * the plot grid read as a single joined estate, with one shared sign and a
 * fence around the whole. Access stays per plot: an estate is how neighbouring
 * land LOOKS, never a permission.
 *
 * Pure, so the server that publishes estates in the minimap, the map that draws
 * them and the tests agree on one rule:
 *
 *  - Adjacency is 4-neighbour on the plot grid (plots are PLOT_COLS x PLOT_ROWS
 *    blocks). Diagonal plots only touch at a corner and are not adjacent.
 *  - An estate is a connected group of at least two NON-PRIVATE plots sharing
 *    the same primary org (the first bound org), or failing that the same
 *    owner. Org estates are found first; a plot belongs to at most one estate.
 *  - A private plot never joins, never bridges two public plots, and is never
 *    named in an estate: joining it would say who holds it. An estate left with
 *    one public plot is not an estate.
 *
 * Plots are allocated by a spiral and a space keeps its plot for life, so
 * adjacency is incidental today (relocation is #35's to build).
 */
import { PLOT_COLS, PLOT_ROWS, plotForIndex } from "./map-layout.js";
import { graphemeCount } from "./graphemes.js";

export const ESTATE_NAME_MAX = 24;

export type EstateKind = "org" | "owner";

/** One plot as the server knows it, before anything is redacted. */
export interface EstateSource {
  plotIndex: number;
  preset: string;
  ownerId: string | null;
  ownerHandle: string | null;
  /** The owner's chosen estate name (humans.estate_name), unchecked. */
  ownerEstateName: string | null;
  /** The plot's primary (first bound) org. */
  orgId: string | null;
  orgName: string | null;
  orgColour: string | null;
  /** The org's chosen estate name (orgs.estate_name), unchecked. */
  orgEstateName: string | null;
  /** The plot's own branding accent (035), already checked, or null. */
  accent: string | null;
}

export interface EstateGroup {
  kind: EstateKind;
  /** Sorted ascending. */
  plotIndices: number[];
}

/** What the public minimap carries. No owner or org ids. */
export interface EstateView {
  id: string;
  kind: EstateKind;
  /** The shared sign's name: the chosen estate name, else the org name / @handle. */
  name: string | null;
  /** The shared fence and sign stripe colour: the org colour, else the owner's accent. */
  accent: string | null;
  /** Member plots, sorted ascending. Never a private plot. */
  plotIndices: number[];
}

/** Block coordinates of a plot on the plot grid. */
export function plotBlock(index: number): { bx: number; by: number } {
  const r = plotForIndex(index);
  return { bx: Math.floor(r.x0 / PLOT_COLS), by: Math.floor(r.y0 / PLOT_ROWS) };
}

/** True when two plots share an edge (not just a corner). */
export function plotsAdjacent(a: number, b: number): boolean {
  const p = plotBlock(a);
  const q = plotBlock(b);
  return Math.abs(p.bx - q.bx) + Math.abs(p.by - q.by) === 1;
}

type Cand = { plotIndex: number; bx: number; by: number; org: string | null; owner: string | null };

/** Group plots into estates. See the rules at the top of this file. */
export function groupEstates(
  plots: ReadonlyArray<Pick<EstateSource, "plotIndex" | "preset" | "ownerId" | "orgId">>,
): EstateGroup[] {
  const byBlock = new Map<string, Cand>();
  for (const p of plots) {
    if (p.preset === "private") continue;
    if (!Number.isInteger(p.plotIndex) || p.plotIndex < 0) continue;
    const { bx, by } = plotBlock(p.plotIndex);
    const k = `${bx},${by}`;
    if (byBlock.has(k)) continue;
    byBlock.set(k, { plotIndex: p.plotIndex, bx, by, org: p.orgId ?? null, owner: p.ownerId ?? null });
  }
  const cands = [...byBlock.values()].sort((a, b) => a.plotIndex - b.plotIndex);
  const taken = new Set<number>();
  const groups: EstateGroup[] = [];
  for (const kind of ["org", "owner"] as const) {
    const keyOf = (c: Cand) => (kind === "org" ? c.org : c.owner);
    for (const start of cands) {
      const key = keyOf(start);
      if (!key || taken.has(start.plotIndex)) continue;
      const seen = new Set<number>([start.plotIndex]);
      const members: Cand[] = [];
      const queue = [start];
      while (queue.length) {
        const c = queue.shift()!;
        members.push(c);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const n = byBlock.get(`${c.bx + dx},${c.by + dy}`);
          if (!n || seen.has(n.plotIndex) || taken.has(n.plotIndex) || keyOf(n) !== key) continue;
          seen.add(n.plotIndex);
          queue.push(n);
        }
      }
      if (members.length < 2) continue;
      for (const m of members) taken.add(m.plotIndex);
      groups.push({ kind, plotIndices: members.map((m) => m.plotIndex).sort((a, b) => a - b) });
    }
  }
  return groups.sort((a, b) => a.plotIndices[0]! - b.plotIndices[0]!);
}

/**
 * Control, invisible formatting, line separators and private use, as for sign
 * text (ZWJ allowed so joined emoji count once).
 */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Co}]|(?!‍)\p{Cf}/u;

/** An estate name to a stored value (null clears) or a plain reason it is refused. */
export function readEstateName(raw: unknown): { ok: true; name: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, name: null };
  if (typeof raw !== "string") return { ok: false, message: "Estate name must be text." };
  if (FORBIDDEN_TEXT.test(raw)) return { ok: false, message: "Estate name must be one line of plain text." };
  const name = raw.replace(/\s+/g, " ").trim().normalize("NFC");
  if (!name) return { ok: true, name: null };
  if (graphemeCount(name) > ESTATE_NAME_MAX) {
    return { ok: false, message: `Estate name can be at most ${ESTATE_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}

function hexOrNull(raw: string | null): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * The public estates for a set of plots. Everything that could identify a
 * private plot, or an owner or org id, stays here: the view carries only an
 * opaque id, a kind, the shared name and accent, and public member plots.
 */
export function publicEstates(plots: readonly EstateSource[]): EstateView[] {
  const at = new Map<number, EstateSource>();
  for (const p of plots) if (p.preset !== "private" && !at.has(p.plotIndex)) at.set(p.plotIndex, p);
  return groupEstates(plots).map((g) => {
    const members = g.plotIndices.map((i) => at.get(i)!);
    const first = members[0]!;
    let name: string | null;
    let accent: string | null;
    if (g.kind === "org") {
      const chosen = readEstateName(first.orgEstateName);
      name = (chosen.ok ? chosen.name : null) ?? (first.orgName?.trim() || null);
      accent = hexOrNull(first.orgColour);
    } else {
      const chosen = readEstateName(first.ownerEstateName);
      name = (chosen.ok ? chosen.name : null) ?? (first.ownerHandle ? `@${first.ownerHandle}` : null);
      accent = members.find((m) => m.accent)?.accent ?? null;
    }
    return { id: `estate-${g.kind}-${g.plotIndices[0]}`, kind: g.kind, name, accent, plotIndices: g.plotIndices };
  });
}
