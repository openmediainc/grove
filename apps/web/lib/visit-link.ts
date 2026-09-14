/**
 * The space page's Visit link (#59). Kept out of lib/space-page, which
 * next.config imports for redirects and so must not pull in @grove/protocol.
 */
import { AT_QUERY } from "./deep-link";
import { plotForIndex } from "./map-layout";
import { roomHref } from "./world-url";

/**
 * Where Visit lands: the map with the room drawer open AND the camera on the
 * space's plot (`?at=`), so the visitor sees the space they chose — and, as a
 * link that targets that plot, its owner default theme (#59). The civic core
 * (no plot) is just the room.
 */
export function visitHref(room: string, plotIndex: number | null): string {
  const href = roomHref(room);
  if (plotIndex === null || !Number.isFinite(plotIndex) || plotIndex < 0) return href;
  const r = plotForIndex(plotIndex);
  const tx = Math.round((r.x0 + r.x1) / 2);
  const ty = Math.round((r.y0 + r.y1) / 2);
  return `${href}${href.includes("?") ? "&" : "?"}${AT_QUERY}=${tx},${ty}`;
}

