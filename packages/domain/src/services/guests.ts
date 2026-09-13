import crypto from "node:crypto";
import { FOLLOWS_MAX, ID_PREFIX, type Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { randomToken } from "../crypto.js";

/** A guest untouched for this long is deleted, with its reactions and follows. */
export const GUEST_TTL_DAYS = 30;
/** How often a process runs the prune. */
export const GUEST_PRUNE_EVERY_MS = 10 * 60_000;
/** A guest's last_seen_at is written at most this often, so a busy guest is not a write per click. */
const TOUCH_EVERY_SECONDS = 3600;
/** Guests deleted per prune, so a backlog never makes one tick slow. */
const PRUNE_BATCH = 500;
/** A guest follows fewer things than a person can. */
export const GUEST_FOLLOWS_MAX = Math.min(50, FOLLOWS_MAX);

export interface Guest {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * The row id for a cookie token: a prefix and a truncated SHA-256. The table
 * never holds the token, so reading it cannot mint a working cookie.
 */
export function guestIdForToken(token: string): string {
  return `${ID_PREFIX.guest}${crypto.createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/** A cookie value we would have issued: base64url, 43 chars for 32 bytes. */
export function isGuestToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(v);
}

/**
 * The key a per-IP guest limiter uses. The address is hashed and truncated
 * before it becomes part of a limiter key, and the key expires with its window:
 * nothing about the address is kept beyond the minute it counts.
 */
export function guestIpBucket(ip: string): string {
  return crypto.createHash("sha256").update(`guest-ip:${ip}`).digest("hex").slice(0, 16);
}

export interface MergeResult {
  reactions: number;
  follows: number;
}

/**
 * Guest passes (migration 034).
 *
 * ---------------------------------------------------------------------------
 * WHAT A GUEST IS
 * ---------------------------------------------------------------------------
 * A browser that reacted or followed while signed out. Issued on that first
 * attempt, never on a page view. A row holds an id, when it was made and when
 * it was last used — no IP, no user agent — and the browser holds the only
 * copy of the token that names it.
 *
 * What a guest may do, and to what, is decided elsewhere: ReactionService and
 * FollowService take a guest as an actor that sees what a signed-out visitor
 * sees, and the kernel (`authorize`, `sender.guest`) allows it the `reaction`
 * channel only, at the non-member ceiling. The routes never authenticate a
 * guest as a person, so every other act answers 401.
 *
 * ---------------------------------------------------------------------------
 * HOW IT ENDS
 * ---------------------------------------------------------------------------
 *  - Sign in: `merge` moves the reactions and follows onto the person (a
 *    duplicate is dropped, not doubled), then deletes the guest.
 *  - Forget: `forget` deletes the guest and everything it did.
 *  - Silence: `prune` deletes guests unused for GUEST_TTL_DAYS, likewise.
 */
export class GuestService {
  private lastPruned = 0;

  constructor(private store: GroveStore) {}

  /** A new guest. Returns the token for the cookie; the row is keyed by its hash. */
  async issue(): Promise<{ guest: Guest; token: string }> {
    const token = randomToken(32);
    const id = guestIdForToken(token);
    const { rows } = await this.store.pg.query(
      `INSERT INTO guests (id) VALUES ($1) RETURNING id, created_at, last_seen_at`,
      [id],
    );
    return { guest: mapGuest(rows[0] as Record<string, unknown>), token };
  }

  /** The guest a cookie names, or null. Touches last_seen_at at most hourly. */
  async fromToken(token: unknown): Promise<Guest | null> {
    if (!isGuestToken(token)) return null;
    const id = guestIdForToken(token);
    const { rows } = await this.store.pg.query(
      `UPDATE guests SET last_seen_at = now()
        WHERE id = $1 AND last_seen_at < now() - make_interval(secs => $2)
        RETURNING id, created_at, last_seen_at`,
      [id, TOUCH_EVERY_SECONDS],
    );
    if (rows[0]) return mapGuest(rows[0] as Record<string, unknown>);
    const seen = await this.store.pg.query(`SELECT id, created_at, last_seen_at FROM guests WHERE id = $1`, [id]);
    return seen.rows[0] ? mapGuest(seen.rows[0] as Record<string, unknown>) : null;
  }

  /** Delete a guest just issued for an act that was then refused, so a refusal leaves nothing behind. */
  async discard(guestId: string): Promise<void> {
    await this.forgetIds([guestId]);
  }

  /** "Forget this browser": the guest, its reactions and its follows. */
  async forget(guestId: string): Promise<void> {
    await this.forgetIds([guestId]);
  }

  /**
   * Move a guest's reactions and follows onto the person who just signed in
   * from that browser, then delete the guest. One transaction.
   *
   * Dedupe: a reaction or follow the person already holds stays one row. A
   * person's follow cap still holds; follows past it are dropped, oldest kept.
   */
  async merge(guestId: string, human: Human): Promise<MergeResult> {
    if (!guestId.startsWith(ID_PREFIX.guest)) throw new GroveError("INVALID", "Not a guest.");
    const client = await this.store.pg.connect();
    try {
      await client.query("BEGIN");
      const exists = await client.query(`SELECT 1 FROM guests WHERE id = $1 FOR UPDATE`, [guestId]);
      if (!exists.rowCount) {
        await client.query("ROLLBACK");
        return { reactions: 0, follows: 0 };
      }
      const reactions = await client.query(
        `INSERT INTO reactions (target_kind, target_id, actor_id, actor_kind, emoji, created_at)
         SELECT target_kind, target_id, $2, 'human', emoji, created_at
           FROM reactions WHERE actor_id = $1 AND actor_kind = 'guest'
         ON CONFLICT DO NOTHING`,
        [guestId, human.id],
      );
      const have = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM follows WHERE follower_id = $1`, [human.id]);
      const room = Math.max(0, FOLLOWS_MAX - (have.rows[0]?.n ?? 0));
      const follows = await client.query(
        `INSERT INTO follows (follower_id, follower_kind, subject_kind, subject_id, created_at)
         SELECT $2, 'human', g.subject_kind, g.subject_id, g.created_at
           FROM follows g
          WHERE g.follower_id = $1 AND g.follower_kind = 'guest'
            AND NOT EXISTS (
              SELECT 1 FROM follows h
               WHERE h.follower_id = $2 AND h.subject_kind = g.subject_kind AND h.subject_id = g.subject_id)
          ORDER BY g.created_at
          LIMIT $3
         ON CONFLICT DO NOTHING`,
        [guestId, human.id, room],
      );
      await client.query(`DELETE FROM reactions WHERE actor_id = $1`, [guestId]);
      await client.query(`DELETE FROM follows WHERE follower_id = $1`, [guestId]);
      await client.query(`DELETE FROM guests WHERE id = $1`, [guestId]);
      await client.query("COMMIT");
      return { reactions: reactions.rowCount ?? 0, follows: follows.rowCount ?? 0 };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete guests unused for GUEST_TTL_DAYS, with what they did. Returns how many guests went. */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - GUEST_TTL_DAYS * 86_400_000).toISOString();
    const { rows } = await this.store.pg.query<{ id: string }>(
      `SELECT id FROM guests WHERE last_seen_at < $1 ORDER BY last_seen_at LIMIT $2`,
      [cutoff, PRUNE_BATCH],
    );
    if (!rows.length) return 0;
    await this.forgetIds(rows.map((r) => r.id));
    return rows.length;
  }

  async maybePrune(now: number = Date.now()): Promise<number> {
    if (now - this.lastPruned < GUEST_PRUNE_EVERY_MS) return 0;
    this.lastPruned = now;
    return this.prune(new Date(now));
  }

  private async forgetIds(ids: string[]): Promise<void> {
    const guestIds = ids.filter((id) => id.startsWith(ID_PREFIX.guest));
    if (!guestIds.length) return;
    await this.store.pg.query(`DELETE FROM reactions WHERE actor_id = ANY($1::text[]) AND actor_kind = 'guest'`, [guestIds]);
    await this.store.pg.query(`DELETE FROM follows WHERE follower_id = ANY($1::text[]) AND follower_kind = 'guest'`, [guestIds]);
    await this.store.pg.query(`DELETE FROM guests WHERE id = ANY($1::text[])`, [guestIds]);
  }
}

function mapGuest(r: Record<string, unknown>): Guest {
  return {
    id: String(r.id),
    createdAt: new Date(String(r.created_at)).toISOString(),
    lastSeenAt: new Date(String(r.last_seen_at)).toISOString(),
  };
}
