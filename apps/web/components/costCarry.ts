/**
 * Carry and deposit: when a body finishes a turn that reported usage, it picks
 * up a small load and the load travels to the treasury in the Plaza.
 *
 * What it may say is exactly what the minimap publishes — that a deposit
 * happened and whether it was priced — and nothing more:
 *
 *   gold sack, "+" at the treasury      a priced report landed
 *   grey sack, "?" at the treasury      a report landed with NO price: the
 *                                       cost was not reported, and the map
 *                                       will not paint it as gold it never saw
 *
 * There is never an amount. The minimap is readable by anyone who can see the
 * world, and what an agent spent is its owner's business (migration 021).
 *
 * The body does not walk to the treasury: where a body stands is motion's, and
 * two systems moving one body would fight. The load leaves the hand instead.
 *
 * Drawn in SCREEN space at a fixed size, like the hazard marks, so a deposit
 * is readable zoomed out across the campus.
 */

type Deposit = { at: string; costed: boolean };

type Trip = { id: string; costed: boolean; start: number; from: { x: number; y: number } | null };

const LIFT_MS = 700;
const CARRY_MS = 1700;
const POP_MS = 700;
const TOTAL_MS = LIFT_MS + CARRY_MS + POP_MS;
/** A deposit older than this when first seen (a reload) is history, not an event. */
const STALE_MS = 150_000;

const GOLD = "#fbbf24";
const GOLD_RIM = "#92400e";
const UNPRICED = "#94a3b8";
const UNPRICED_RIM = "#334155";

export class CostCarry {
  private seen = new Set<string>();
  private trips: Trip[] = [];
  /** Where each body was drawn this frame, in layout space. */
  private at = new Map<string, { x: number; y: number }>();

  /** Feed every minimap poll. Each distinct deposit starts one trip, once. */
  sync(bodies: ReadonlyArray<{ id: string; deposit?: Deposit | null }>, now: number = Date.now()): void {
    for (const b of bodies) {
      const d = b.deposit;
      if (!d) continue;
      const key = `${b.id}@${d.at}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const landed = Date.parse(d.at);
      if (Number.isFinite(landed) && now - landed > STALE_MS) continue;
      this.trips.push({ id: b.id, costed: d.costed, start: now, from: null });
    }
    // Keys only need to outlive the server's deposit window.
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
  }

  /** Call from the body loop with the position the body was drawn at (layout space). */
  note(id: string, x: number, y: number): void {
    this.at.set(id, { x, y });
  }

  /**
   * @param toScreen layout -> screen
   * @param treasury the deposit point, layout space
   */
  draw(
    ctx: CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => { x: number; y: number },
    treasury: { x: number; y: number },
    reduceMotion: boolean,
    /** The theme's resource colours; unpriced stays grey in every theme. */
    coin: { coin: string; rim: string } = { coin: GOLD, rim: GOLD_RIM },
    now: number = Date.now(),
  ): void {
    if (this.trips.length === 0) {
      this.at.clear();
      return;
    }
    const bank = toScreen(treasury.x, treasury.y);
    const live: Trip[] = [];
    for (const trip of this.trips) {
      const age = now - trip.start;
      if (age > TOTAL_MS) continue;
      const here = this.at.get(trip.id);
      // Remember the hand the load left from, so a body that walks on (or out
      // of view) does not drag its load along after it let go.
      if (here && (trip.from === null || age < LIFT_MS)) trip.from = toScreen(here.x, here.y);
      if (!trip.from) {
        // Never drawn (fogged, off-screen): nothing honest to animate from.
        if (age < LIFT_MS) live.push(trip);
        continue;
      }
      live.push(trip);
      const fill = trip.costed ? coin.coin : UNPRICED;
      const rim = trip.costed ? coin.rim : UNPRICED_RIM;
      if (reduceMotion) {
        if (age > LIFT_MS) this.pop(ctx, bank.x, bank.y - 18, Math.min(1, (age - LIFT_MS) / (CARRY_MS + POP_MS)), trip.costed ? coin.coin : null);
        else sack(ctx, trip.from.x + 12, trip.from.y - 4, fill, rim, trip.costed, 1);
        continue;
      }
      if (age < LIFT_MS) {
        const p = age / LIFT_MS;
        sack(ctx, trip.from.x + 12, trip.from.y - 2 - 8 * easeOut(p), fill, rim, trip.costed, 0.6 + 0.4 * p);
      } else if (age < LIFT_MS + CARRY_MS) {
        const p = easeInOut((age - LIFT_MS) / CARRY_MS);
        const sx = trip.from.x + 12;
        const sy = trip.from.y - 10;
        const ex = bank.x;
        const ey = bank.y - 18;
        const arc = Math.min(90, 30 + Math.hypot(ex - sx, ey - sy) * 0.25);
        const x = sx + (ex - sx) * p;
        const y = sy + (ey - sy) * p - Math.sin(Math.PI * p) * arc;
        sack(ctx, x, y, fill, rim, trip.costed, 1 - 0.25 * p);
      } else {
        this.pop(ctx, bank.x, bank.y - 18, (age - LIFT_MS - CARRY_MS) / POP_MS, trip.costed ? coin.coin : null);
      }
    }
    this.trips = live;
    this.at.clear();
  }

  private pop(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, coin: string | null): void {
    const costed = coin !== null;
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.strokeStyle = coin ?? UNPRICED;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6 + 14 * p, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = coin ?? UNPRICED;
    ctx.fillText(costed ? "+" : "?", x, y - 10 - 8 * p);
    ctx.restore();
  }
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/** A small tied sack, ~12px. The mark on it says priced ($) or not reported (?). */
function sack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fill: string,
  rim: string,
  costed: boolean,
  scale: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(0, 7, 6, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-3, -4);
  ctx.quadraticCurveTo(-7, 0, -6, 4);
  ctx.quadraticCurveTo(0, 8, 6, 4);
  ctx.quadraticCurveTo(7, 0, 3, -4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-3, -4);
  ctx.lineTo(-4, -7);
  ctx.lineTo(4, -7);
  ctx.lineTo(3, -4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rim;
  ctx.font = "bold 7px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(costed ? "$" : "?", 0, 4);
  ctx.restore();
}
