/**
 * Who may cover a body (queue #52): the pure half.
 *
 * "Bodies get hidden behind other UI." On the canvas the map paints, in order:
 * ground, claimed land, ONE depth-sorted list of buildings and bodies (a
 * building strictly in front may hide the lower part of a body — the isometric
 * rule), the hour's colour grade, lamps, and then things you read. Some of
 * those read-things are big boxes at a fixed SCREEN size — plot signboards,
 * estate signs, district names — and zoomed out they used to be painted
 * straight over whoever was standing in front of the building. And the hover
 * card sat in the bottom-left corner whoever was standing there.
 *
 * The rules, testable without a canvas:
 *
 *  - `bodyScreenRect`: the screen box a body occupies (sprite, ring, the mark
 *    slots above its head), at any zoom.
 *  - `holeRuns`: those boxes as a set of NON-OVERLAPPING grid runs, so a clip
 *    path with the even-odd rule can cut every body out of the sign pass. Two
 *    overlapping holes under even-odd would cancel back into "painted", which
 *    is why the union is snapped to a grid first.
 *  - `hoverCardSpot`: the corner the hover card goes in, never over the body
 *    it is describing.
 *  - `clearCentre`: the middle of the part of the map a drawer does not
 *    cover, so the follow-cam and a glide put a body where it can be seen.
 */

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** A body's extent round its anchor, in layout px: 40px sprite, ground ring, mark slots above the head. */
export const BODY_EXTENT = { left: 22, right: 22, up: 34, down: 24 } as const;

export function bodyScreenRect(lx: number, ly: number, zoom: number, px: number, py: number): Rect {
  const sx = lx * zoom + px;
  const sy = ly * zoom + py;
  return {
    x0: sx - BODY_EXTENT.left * zoom,
    x1: sx + BODY_EXTENT.right * zoom,
    y0: sy - BODY_EXTENT.up * zoom,
    y1: sy + BODY_EXTENT.down * zoom,
  };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * The union of `rects`, clipped to the viewport, as horizontal runs of grid
 * cells. Every point of every input rect (inside the viewport) is covered, and
 * no two output rects overlap — the property an even-odd clip needs.
 */
export function holeRuns(rects: readonly Rect[], cell: number, viewport: { w: number; h: number }): Rect[] {
  const c = Math.max(2, cell);
  const cols = Math.ceil(viewport.w / c);
  const rows = Math.ceil(viewport.h / c);
  const on = new Map<number, Set<number>>();
  for (const r of rects) {
    const cx0 = Math.max(0, Math.floor(r.x0 / c));
    const cx1 = Math.min(cols - 1, Math.ceil(r.x1 / c) - 1);
    const cy0 = Math.max(0, Math.floor(r.y0 / c));
    const cy1 = Math.min(rows - 1, Math.ceil(r.y1 / c) - 1);
    for (let y = cy0; y <= cy1; y++) {
      let row = on.get(y);
      if (!row) on.set(y, (row = new Set()));
      for (let x = cx0; x <= cx1; x++) row.add(x);
    }
  }
  const out: Rect[] = [];
  for (const [y, row] of [...on.entries()].sort((a, b) => a[0] - b[0])) {
    const xs = [...row].sort((a, b) => a - b);
    let start = xs[0]!;
    let prev = start;
    for (let i = 1; i <= xs.length; i++) {
      const x = xs[i];
      if (x !== undefined && x === prev + 1) {
        prev = x;
        continue;
      }
      out.push({ x0: start * c, x1: (prev + 1) * c, y0: y * c, y1: (y + 1) * c });
      if (x !== undefined) start = prev = x;
    }
  }
  return out;
}

/**
 * Where the hover card goes: bottom-left as it always has, unless that would
 * cover the body it describes — then bottom-right, then top-left. `avoid` is
 * the body's own screen box.
 */
export function hoverCardSpot(
  avoid: Rect | null,
  card: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 12,
): { x: number; y: number } {
  const w = Math.min(card.w, Math.max(0, viewport.w - margin * 2));
  const spots = [
    { x: margin, y: viewport.h - card.h - margin },
    { x: viewport.w - w - margin, y: viewport.h - card.h - margin },
    { x: margin, y: margin },
    { x: viewport.w - w - margin, y: margin },
  ];
  if (!avoid) return spots[0]!;
  for (const s of spots) {
    if (!overlaps({ x0: s.x, y0: s.y, x1: s.x + w, y1: s.y + card.h }, avoid)) return s;
  }
  return spots[0]!;
}

/**
 * The centre of the map the viewer can actually see. A drawer docked on the
 * right (a wide screen) moves it left; a bottom sheet (a phone) moves it up.
 * A cover that leaves less than `minClear` px either way is ignored: there is
 * nowhere better to put the subject than the middle.
 */
export function clearCentre(viewport: { w: number; h: number }, covers: readonly Rect[], minClear = 96): { x: number; y: number } {
  let right = viewport.w;
  let bottom = viewport.h;
  for (const c of covers) {
    if (c.x1 <= 0 || c.y1 <= 0 || c.x0 >= viewport.w || c.y0 >= viewport.h) continue;
    const tall = c.y0 <= viewport.h * 0.1 && c.y1 >= viewport.h * 0.9;
    const wide = c.x0 <= viewport.w * 0.1 && c.x1 >= viewport.w * 0.9;
    if (tall && c.x0 > 0 && c.x0 >= minClear) right = Math.min(right, c.x0);
    else if (wide && c.y0 > 0 && c.y0 >= minClear) bottom = Math.min(bottom, c.y0);
  }
  return { x: right / 2, y: bottom / 2 };
}
