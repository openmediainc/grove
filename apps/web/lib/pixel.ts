const STORAGE_KEY = "grove-pixel";

export function readPixelFlag(): boolean {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_GROVE_PIXEL !== "0";
  }
  const q = new URLSearchParams(window.location.search).get("pixel");
  if (q === "1") return true;
  if (q === "0") return false;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") return true;
    if (window.localStorage.getItem(STORAGE_KEY) === "0") return false;
  } catch {
    /* private mode */
  }
  if (process.env.NEXT_PUBLIC_GROVE_PIXEL === "0") return false;
  return true;
}

export function writePixelFlag(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export const TILE_ROOMS = ["plaza", "library", "workshop", "stage", "garden", "board"] as const;
export type TileRoom = (typeof TILE_ROOMS)[number];

export function tileRoomOf(slug: string | undefined | null): TileRoom {
  const s = (slug ?? "plaza").toLowerCase();
  return (TILE_ROOMS as readonly string[]).includes(s) ? (s as TileRoom) : "plaza";
}
