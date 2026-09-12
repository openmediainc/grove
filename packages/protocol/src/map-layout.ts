/** Age-of-Empires-lite campus grid. Original 64px tiles are squashed to 2:1 diamonds in the client. */
export const MAP_COLS = 24;
export const MAP_ROWS = 18;

export type MapRegion = "plaza" | "library" | "workshop" | "stage" | "garden" | "board" | "wild";

type Rect = { x0: number; y0: number; x1: number; y1: number };

export const REGION_RECTS: Record<Exclude<MapRegion, "wild">, Rect> = {
  plaza: { x0: 8, y0: 6, x1: 15, y1: 11 },
  library: { x0: 8, y0: 0, x1: 15, y1: 5 },
  garden: { x0: 8, y0: 12, x1: 15, y1: 17 },
  stage: { x0: 0, y0: 6, x1: 7, y1: 11 },
  workshop: { x0: 16, y0: 6, x1: 23, y1: 11 },
  board: { x0: 16, y0: 12, x1: 23, y1: 17 },
};

export const PLAZA_CENTER = { x: 11.5, y: 8.5 };

export function regionAt(tx: number, ty: number): MapRegion {
  for (const [name, r] of Object.entries(REGION_RECTS) as Array<[Exclude<MapRegion, "wild">, Rect]>) {
    if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return name;
  }
  return "wild";
}

/** Fog radius in tiles. Grows with claimed Grove agents + live bodies; Mini-scale only. */
export function exploreRadius(claimedAgents: number, liveBodies: number): number {
  const claimed = Math.max(0, claimedAgents);
  const live = Math.max(0, liveBodies);
  return Math.min(18, 4 + claimed + Math.min(8, live));
}

export function tileExplored(tx: number, ty: number, radius: number): boolean {
  const dx = tx - PLAZA_CENTER.x;
  const dy = ty - PLAZA_CENTER.y;
  return Math.hypot(dx, dy) <= radius;
}

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function seatInRegion(id: string, region: MapRegion): { x: number; y: number } {
  const rect = region === "wild" ? REGION_RECTS.plaza : REGION_RECTS[region];
  const h = hash32(id);
  const w = rect.x1 - rect.x0 + 1;
  const ht = rect.y1 - rect.y0 + 1;
  return { x: rect.x0 + (h % w), y: rect.y0 + (Math.floor(h / w) % ht) };
}

export function paperclipHome(role: string | undefined, status: string | undefined): MapRegion {
  const r = (role ?? "").toLowerCase();
  const s = (status ?? "").toLowerCase();
  if (s === "error") return "board";
  if (r === "ceo") return "plaza";
  if (r === "engineer") return "workshop";
  if (r === "general") return "library";
  return "workshop";
}
