/**
 * Estates on the map (#37): what the renderer needs to draw one joined estate —
 * its member plots, the fence round its outer edge and where its one shared
 * sign hangs. Pure. Who forms an estate is decided on the server
 * (@grove/protocol estates.ts); this file only re-checks the payload and does
 * the geometry.
 *
 * Privacy, again here so a stale or hand-made payload cannot break it: a
 * private plot is never drawn as part of an estate, and an estate left with
 * fewer than two plots is not drawn at all.
 */
import { PLOT_COLS, PLOT_ROWS, plotsAdjacent, type EstateKind, type PlotRect } from "@grove/protocol";

export type EstateWire = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  accent?: unknown;
  plot_indices?: unknown;
  plotIndices?: unknown;
};

export type MapEstate = {
  id: string;
  kind: EstateKind;
  name: string | null;
  accent: string | null;
  /** Sorted ascending; every one a known, non-private plot. */
  plotIndices: number[];
};

/** Estates off the wire, re-checked against the plots the map actually has. */
export function readEstates(
  wire: unknown,
  plots: ReadonlyArray<{ plotIndex: number; preset: string }>,
): MapEstate[] {
  if (!Array.isArray(wire)) return [];
  const open = new Set(plots.filter((p) => p.preset !== "private").map((p) => p.plotIndex));
  const used = new Set<number>();
  const out: MapEstate[] = [];
  for (const raw of wire as EstateWire[]) {
    if (!raw || typeof raw !== "object") continue;
    const list = (raw.plot_indices ?? raw.plotIndices) as unknown;
    if (!Array.isArray(list)) continue;
    const members = [...new Set(list.filter((i): i is number => Number.isInteger(i) && open.has(i as number) && !used.has(i as number)))].sort(
      (a, b) => a - b,
    );
    if (members.length < 2 || !connected(members)) continue;
    for (const m of members) used.add(m);
    const accent = typeof raw.accent === "string" && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toLowerCase() : null;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
    out.push({
      id: typeof raw.id === "string" ? raw.id : `estate-${members[0]}`,
      kind: raw.kind === "org" ? "org" : "owner",
      name,
      accent,
      plotIndices: members,
    });
  }
  return out;
}

function connected(members: readonly number[]): boolean {
  const seen = new Set<number>([members[0]!]);
  const queue = [members[0]!];
  while (queue.length) {
    const c = queue.shift()!;
    for (const m of members) {
      if (!seen.has(m) && plotsAdjacent(c, m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return seen.size === members.length;
}

/** Which face of a tile diamond: n = top-right (y0 edge), e = x1, s = y1, w = x0. */
export type TileSide = "n" | "e" | "s" | "w";

/**
 * The outward faces of the union of `rects`: every tile edge on the estate's
 * outside, and none of the seams between member plots, so the fence is one
 * continuous line round the whole.
 */
export function estatePerimeter(rects: readonly PlotRect[]): Array<{ tx: number; ty: number; side: TileSide }> {
  const inside = (tx: number, ty: number) => rects.some((r) => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1);
  const out: Array<{ tx: number; ty: number; side: TileSide }> = [];
  for (const r of rects) {
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) {
        if (tx > r.x0 && tx < r.x1 && ty > r.y0 && ty < r.y1) continue;
        if (ty === r.y0 && !inside(tx, ty - 1)) out.push({ tx, ty, side: "n" });
        if (tx === r.x1 && !inside(tx + 1, ty)) out.push({ tx, ty, side: "e" });
        if (ty === r.y1 && !inside(tx, ty + 1)) out.push({ tx, ty, side: "s" });
        if (tx === r.x0 && !inside(tx - 1, ty)) out.push({ tx, ty, side: "w" });
      }
    }
  }
  return out;
}

/**
 * Where the shared sign hangs, in TILE coordinates: on the seam between two
 * member plots (clear of both buildings), choosing the seam nearest the middle
 * of the estate. Each plot's own board stays on its building's front.
 */
export function estateSignTile(indices: readonly number[], rectOf: (i: number) => PlotRect): { x: number; y: number } {
  const centre = (i: number) => {
    const r = rectOf(i);
    return { x: r.x0 + PLOT_COLS / 2, y: r.y0 + PLOT_ROWS / 2 };
  };
  const cs = indices.map(centre);
  const mid = { x: cs.reduce((s, c) => s + c.x, 0) / cs.length, y: cs.reduce((s, c) => s + c.y, 0) / cs.length };
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      if (!plotsAdjacent(indices[i]!, indices[j]!)) continue;
      const p = { x: (cs[i]!.x + cs[j]!.x) / 2, y: (cs[i]!.y + cs[j]!.y) / 2 };
      const d = Math.hypot(p.x - mid.x, p.y - mid.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best ?? cs[0] ?? { x: 0, y: 0 };
}
