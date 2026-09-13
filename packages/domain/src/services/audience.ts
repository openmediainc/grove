/**
 * How many people are watching the map right now — counted, never named.
 *
 * WHY HEARTBEATS AND NOT SOCKETS. The public deploy is serverless
 * (Vercel + `REDIS_URL=pg`): there is no process that holds a spectator's
 * connection for longer than one request, so "open WebSockets" is not a number
 * anyone there can read. What every map viewer DOES do is poll
 * `GET /api/v1/world/minimap` every 8 seconds. Each poll is a heartbeat, and
 * the audience is the number of distinct heartbeats in the last window.
 * The Mini's plaza SSE is not added on top: the map page opens that stream AND
 * polls, so counting both would count every watcher twice.
 *
 * WHAT A HEARTBEAT IS. A random token the TAB made up when it loaded, held in
 * memory and gone on reload. It is not a session, a cookie, an IP, a hash of an
 * IP, or anything that survives the page: the server cannot tell who it is,
 * only that the same tab asked again. The only thing ever read back out is a
 * count.
 *
 * HOW IT IS KEPT SMALL. Tokens land in a set per time bucket
 * (`audience:<world>:<bucket>`). "Watching" is the union of this bucket and the
 * one before, so a viewer polling every 8 seconds is never dropped at a bucket
 * boundary and a closed tab is gone within two buckets. Every bucket key
 * carries a TTL, and the first heartbeat of a new bucket also deletes the
 * bucket two back — PgRedis only filters expired rows, it never purges them,
 * so without that delete the table would grow by one row per tab per page load
 * forever. A bucket stops accepting new tokens at AUDIENCE_CAP, so a script
 * inventing tokens can inflate the pill to the cap and no further.
 */

/** Width of one bucket. The map polls every 8s, so each bucket sees a viewer ≥3 times. */
export const AUDIENCE_BUCKET_SECONDS = 30;
/** Most distinct tokens one bucket will hold. The pill reads "N+" at the cap. */
export const AUDIENCE_CAP = 500;

/** The part of ioredis (and PgRedis) this needs. */
export interface AudienceSetStore {
  sadd(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

/** A tab's token: short, random-looking, and nothing else. */
export function isWatchToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{12,40}$/.test(token);
}

export function audienceBucket(nowMs: number): number {
  return Math.floor(nowMs / (AUDIENCE_BUCKET_SECONDS * 1000));
}

export function audienceKey(worldId: string, bucket: number): string {
  return `audience:${worldId}:${bucket}`;
}

export class AudienceService {
  /** Per-world "is this bucket full" memo, so a full bucket costs no write. */
  private full = new Map<string, number>();

  constructor(private redis: AudienceSetStore) {}

  /**
   * Record one heartbeat (if the token is well-formed) and return how many
   * distinct tabs have heartbeated in this bucket or the previous one.
   * Never throws: an audience count is decoration, and the map must not fail
   * because the kv store hiccupped.
   */
  async heartbeat(worldId: string, token: unknown, nowMs: number = Date.now()): Promise<number | null> {
    try {
      const bucket = audienceBucket(nowMs);
      const cur = audienceKey(worldId, bucket);
      const prev = audienceKey(worldId, bucket - 1);
      if (isWatchToken(token) && this.full.get(worldId) !== bucket) {
        const added = await this.redis.sadd(cur, token);
        if (added === 1) {
          await this.redis.expire(cur, AUDIENCE_BUCKET_SECONDS * 3);
          await this.redis.del(audienceKey(worldId, bucket - 2));
        }
      }
      const [a, b] = await Promise.all([this.redis.smembers(cur), this.redis.smembers(prev)]);
      if (a.length >= AUDIENCE_CAP) this.full.set(worldId, bucket);
      const seen = new Set(a);
      for (const m of b) seen.add(m);
      return Math.min(seen.size, AUDIENCE_CAP);
    } catch {
      return null;
    }
  }
}
