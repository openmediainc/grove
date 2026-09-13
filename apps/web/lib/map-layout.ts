/**
 * The campus grid. This file used to be a hand-kept COPY of
 * packages/protocol/src/map-layout.ts and drifted twice; it is now a thin
 * re-export, mirroring how packages/domain consumes the same module.
 * Import sites keep using "@/lib/map-layout" unchanged.
 */
export {
  MAP_COLS,
  MAP_ROWS,
  PLOT_COLS,
  PLOT_ROWS,
  REGION_RECTS,
  PLAZA_CENTER,
  blockRing,
  exploreRadius,
  hash32,
  isCoreTile,
  paperclipHome,
  plotForIndex,
  regionAt,
  ringCapacity,
  ringsNeeded,
  seatInRegion,
  tileExplored,
  worldBounds,
  type MapRegion,
  type PlotRect,
} from "@grove/protocol";
