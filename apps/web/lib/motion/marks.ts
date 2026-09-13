/**
 * The marks motion adds to a body. Like the hazard triangle and the stall ring
 * (lib/themes/types.ts), these are SEMANTICS, not art: a theme may not restyle
 * "this call failed" into something softer, and a determinate bar may not be
 * drawn for a call that reported no progress. So they live here, fixed, and
 * every theme gets the same ones.
 */
import type { ToolCallOutcome, ToolCallView } from "@grove/protocol";
import type { ScaffoldStage } from "@/lib/art";

type Ctx = CanvasRenderingContext2D;

export const OUTCOME_COLOUR: Readonly<Record<ToolCallOutcome, string>> = {
  ok: "#86efac",
  error: "#f87171",
  cancelled: "#94a3b8",
  stalled: "#fb923c",
};

/**
 * Scaffold stage from REAL progress only. Null progress is stage 1 forever:
 * the site is staked out, and nothing about how far along it is is known.
 */
export function scaffoldStageFor(progress: number | null | undefined): ScaffoldStage {
  if (progress == null || !Number.isFinite(progress)) return 1;
  if (progress < 1 / 3) return 1;
  if (progress < 2 / 3) return 2;
  return 3;
}

/**
 * The work bar under a working body (layout space, body centre at x,y).
 * Determinate only when the span carries progress; otherwise an unfilled track
 * with a short segment sweeping across it — "busy, amount unknown" — which
 * stands still under reduced motion rather than pretending to move.
 */
export function drawWorkBar(ctx: Ctx, span: ToolCallView, x: number, y: number, t: number, reducedMotion: boolean): void {
  const w = 26;
  const h = 3;
  const bx = Math.round(x - w / 2);
  const by = Math.round(y + 14);
  ctx.save();
  ctx.fillStyle = "rgba(7,8,20,0.85)";
  ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
  ctx.fillStyle = "rgba(251,191,36,0.22)";
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = "rgba(251,191,36,0.95)";
  if (span.progress != null) {
    ctx.fillRect(bx, by, Math.max(1, Math.round(w * Math.min(1, Math.max(0, span.progress)))), h);
  } else {
    const seg = 8;
    const p = reducedMotion ? 0.5 : ((t / 900) % 1 + 1) % 1;
    const sx = bx + Math.round((w - seg) * (0.5 - 0.5 * Math.cos(p * Math.PI * 2)));
    ctx.fillRect(sx, by, seg, h);
  }
  ctx.restore();
}

/**
 * A finish, played on the body for a couple of seconds (age 0..1):
 *   ok        — a green puff rising and opening
 *   error     — a red cross that holds, then fades
 *   cancelled — a grey bar
 * Server-closed `stalled` gets no mark: the dashed ring already said it.
 */
export function drawOutcomeMark(
  ctx: Ctx,
  outcome: ToolCallOutcome,
  x: number,
  y: number,
  age: number,
  reducedMotion: boolean,
): void {
  if (outcome === "stalled") return;
  const a = Math.max(0, Math.min(1, age));
  const colour = OUTCOME_COLOUR[outcome];
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y - 26 - (reducedMotion ? 0 : 8 * a)));
  ctx.globalAlpha = 1 - a * a;
  ctx.fillStyle = "rgba(7,8,20,0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 2;
  if (outcome === "ok") {
    const r = reducedMotion ? 9 : 6 + 10 * a;
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3;
      ctx.fillRect(Math.cos(ang) * r - 1.5, Math.sin(ang) * r * 0.7 - 1.5, 3, 3);
    }
    ctx.beginPath();
    ctx.moveTo(-3.5, 0);
    ctx.lineTo(-1, 2.5);
    ctx.lineTo(3.5, -2.5);
    ctx.stroke();
  } else if (outcome === "error") {
    ctx.beginPath();
    ctx.moveTo(-3.5, -3.5);
    ctx.lineTo(3.5, 3.5);
    ctx.moveTo(3.5, -3.5);
    ctx.lineTo(-3.5, 3.5);
    ctx.stroke();
  } else {
    ctx.fillRect(-4, -1, 8, 2);
  }
  ctx.restore();
}

/** The stance, as a single letter on a small banner above the pennant, at the body's left shoulder. */
export const STANCE_LETTER: Readonly<Record<string, string>> = {
  hang_out: "H",
  await_orders: "A",
  work: "W",
  perform: "P",
  scribe: "S",
};

export function drawStanceMark(ctx: Ctx, stance: string, x: number, y: number): void {
  const letter = STANCE_LETTER[stance];
  if (!letter) return;
  ctx.save();
  ctx.translate(Math.round(x - 16), Math.round(y - 30));
  ctx.fillStyle = "rgba(7,8,20,0.82)";
  ctx.beginPath();
  ctx.moveTo(-5, -6);
  ctx.lineTo(5, -6);
  ctx.lineTo(5, 4);
  ctx.lineTo(0, 7);
  ctx.lineTo(-5, 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(244,209,154,0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#f4d19a";
  ctx.font = "bold 8px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(letter, 0, 2);
  ctx.restore();
}
