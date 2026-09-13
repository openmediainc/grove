/**
 * Transfer & relocate on the Manage tab and in the Inbox (queue #35). Pure, so
 * the confirmation gate and the mini map are testable. The API re-checks the
 * same confirmation (`confirmsSlug` from @grove/protocol); gating the button
 * here only saves a round trip.
 */
import { PLOT_COLS, PLOT_ROWS, confirmsSlug, plotBlock } from "@grove/protocol";

export type TransferPick = { kind: "member"; humanId: string } | { kind: "org"; orgId: string } | null;

/** Whether "Offer the space" may be pressed. */
export function canOfferTransfer(input: { pick: TransferPick; typed: string; slug: string; busy?: boolean; pending?: boolean }): boolean {
  if (input.busy || input.pending || !input.pick) return false;
  return confirmsSlug(input.typed, input.slug);
}

/** Whether "Move here" may be pressed. */
export function canRelocate(input: {
  target: number | null;
  current: number;
  typed: string;
  slug: string;
  nextAllowedAt: string | null;
  busy?: boolean;
  now?: number;
}): boolean {
  if (input.busy || input.target === null || input.target === input.current) return false;
  if (input.nextAllowedAt && new Date(input.nextAllowedAt).getTime() > (input.now ?? Date.now())) return false;
  return confirmsSlug(input.typed, input.slug);
}

/** The wire body for an offer. */
export function transferBody(pick: Exclude<TransferPick, null>, typed: string, leave: boolean): Record<string, unknown> {
  return pick.kind === "org"
    ? { to_org_id: pick.orgId, confirm: typed, leave }
    : { to_human_id: pick.humanId, confirm: typed, leave };
}

/** "3 days", "5 hours", "under an hour": how long an offer has left. */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "ran out";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "under an hour";
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}

export type PreviewCell = { bx: number; by: number; role: "core" | "taken" | "anchor" | "current" | "option" | "target" };

/**
 * A mini map of plot blocks around a move: the core, other held plots, your
 * other plots, where the space is now and where it would go. Indices only —
 * the preview carries no names.
 */
export function previewCells(input: {
  current: number;
  taken: number[];
  anchors: number[];
  options: number[];
  target: number | null;
}): { cells: PreviewCell[]; minBx: number; minBy: number; cols: number; rows: number } {
  const byKey = new Map<string, PreviewCell>();
  const put = (bx: number, by: number, role: PreviewCell["role"]) => byKey.set(`${bx},${by}`, { bx, by, role });
  for (let bx = 0; bx < 3; bx++) for (let by = 0; by < 3; by++) put(bx, by, "core");
  for (const i of input.taken) put(plotBlock(i).bx, plotBlock(i).by, "taken");
  for (const i of input.anchors) put(plotBlock(i).bx, plotBlock(i).by, "anchor");
  for (const i of input.options) put(plotBlock(i).bx, plotBlock(i).by, "option");
  const cur = plotBlock(input.current);
  put(cur.bx, cur.by, "current");
  if (input.target !== null) put(plotBlock(input.target).bx, plotBlock(input.target).by, "target");
  const cells = [...byKey.values()];
  const xs = cells.map((c) => c.bx);
  const ys = cells.map((c) => c.by);
  const minBx = Math.min(...xs);
  const minBy = Math.min(...ys);
  return { cells, minBx, minBy, cols: Math.max(...xs) - minBx + 1, rows: Math.max(...ys) - minBy + 1 };
}

/** Plot blocks are wider than tall; the preview keeps that shape. */
export const PREVIEW_ASPECT = PLOT_COLS / PLOT_ROWS;
