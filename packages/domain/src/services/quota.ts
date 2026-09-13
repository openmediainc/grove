import type { Redis } from "ioredis";
import type { QuotaSnapshot } from "@grove/protocol";
import { GroveError } from "../errors.js";

const HOUR = 3600;
const DAY = 86400;

export interface RateLimiter {
  incr(key: string, windowSec: number): Promise<number>;
  get(key: string): Promise<number>;
  setPx(key: string, value: string, ms: number): Promise<void>;
  ttlMs(key: string): Promise<number>;
  exists(key: string): Promise<boolean>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async incr(key: string, windowSec: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSec);
    return n;
  }

  async get(key: string): Promise<number> {
    const v = await this.redis.get(key);
    return v ? Number(v) : 0;
  }

  async setPx(key: string, value: string, ms: number): Promise<void> {
    await this.redis.set(key, value, "PX", ms);
  }

  async ttlMs(key: string): Promise<number> {
    return this.redis.pttl(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private counts = new Map<string, { n: number; exp: number }>();
  private kv = new Map<string, { v: string; exp: number }>();

  async incr(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const cur = this.counts.get(key);
    if (!cur || cur.exp < now) {
      this.counts.set(key, { n: 1, exp: now + windowSec * 1000 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }

  async get(key: string): Promise<number> {
    const now = Date.now();
    const cur = this.counts.get(key);
    if (!cur || cur.exp < now) return 0;
    return cur.n;
  }

  async setPx(key: string, value: string, ms: number): Promise<void> {
    this.kv.set(key, { v: value, exp: Date.now() + ms });
  }

  async ttlMs(key: string): Promise<number> {
    const cur = this.kv.get(key) ?? this.counts.get(key);
    if (!cur) return -2;
    return Math.max(0, cur.exp - Date.now());
  }

  async exists(key: string): Promise<boolean> {
    const now = Date.now();
    const a = this.kv.get(key);
    if (a && a.exp >= now) return true;
    const b = this.counts.get(key);
    return Boolean(b && b.exp >= now);
  }
}

export function isFirst24h(claimedAt: string | null | undefined): boolean {
  if (!claimedAt) return false;
  return Date.now() - Date.parse(claimedAt) < 24 * HOUR * 1000;
}

/**
 * Which limiter refused, and what the caller needs in order to act on it.
 *
 * WHY THIS EXISTS. A `RATE_LIMITED` GroveError used to carry a sentence and
 * nothing else. apps/api/src/http.ts knows every limiter's SHAPE — it derives
 * the whole table by running this file — but it could not know which of a
 * route's buckets had just refused, so `Retry-After` fell back to the shortest
 * window of every bucket the route might charge. A floor: correct, and often
 * far too eager. A spent register day-window was told to come back in an hour.
 *
 * These three fields are read off the limiter that actually refused, at the
 * moment it refused, so a consumer can be exact instead of conservative.
 *
 * NO LIMIT IS WRITTEN DOWN HERE. `resetMs` is the limiter's own TTL for the key
 * that refused; `remaining` is computed from the same `limit` the branch above
 * it just tested. Nothing downstream has to know a window length to use either,
 * and the runtime derivation in http.ts keeps working untouched — `refuse()`
 * calls `ttlMs`, never `incr`, so the probe's "which key refused" bookkeeping
 * still sees exactly what it saw before.
 */
export type RateLimitDetails = {
  /**
   * Bucket name, spelled exactly as the derived table in apps/api/src/http.ts
   * spells it (`write` vs `write_new`, `join_request` vs `join_request_new`),
   * so a consumer can find the refusal in `RateLimit-Policy` without a mapping
   * table that could drift.
   */
  limiter: string;
  /**
   * Calls left in the refusing window. Always 0 when this error is thrown — but
   * computed, not asserted, so a consumer can stop hard-coding the zero.
   */
  remaining: number;
  /**
   * Milliseconds until the refusing key frees. Falls back to the full window
   * only when the limiter cannot say (a Redis key with no TTL, an instrumented
   * limiter that keeps none) — never to a global constant.
   */
  resetMs: number;
};

export class QuotaService {
  constructor(private limiter: RateLimiter) {}

  /**
   * Refuse, naming the limiter that did it.
   *
   * The TTL read happens only on the refusal path, so nothing is added to a
   * call that succeeds.
   */
  private async refuse(
    limiter: string,
    key: string,
    limit: number,
    used: number,
    fallbackMs: number,
    message: string,
  ): Promise<never> {
    const ttl = await this.limiter.ttlMs(key);
    throw new GroveError("RATE_LIMITED", message, {
      details: {
        limiter,
        remaining: Math.max(0, limit - used),
        resetMs: ttl > 0 ? ttl : fallbackMs,
      } satisfies RateLimitDetails,
    });
  }

  async snapshotForSay(actorId: string, roomId: string, first24h: boolean): Promise<QuotaSnapshot> {
    const sayLimit = first24h ? 4 : 8;
    const writeLimit = first24h ? 15 : 30;
    const sayCount = await this.limiter.get(`ratelimit:${actorId}:room_say:min`);
    const writeCount = await this.limiter.get(`ratelimit:${actorId}:write:min`);
    const roomWindowCount = await this.limiter.get(`ratelimit:${actorId}:room:${roomId}:say:min`);
    const gapBusy = await this.limiter.exists(`ratelimit:${actorId}:room_say:gap`);
    return {
      roomSayRemaining: Math.max(0, sayLimit - sayCount),
      roomSayGapOk: !gapBusy,
      writeRemaining: Math.max(0, writeLimit - writeCount),
      roomWindowCount,
    };
  }

  async consumeSay(actorId: string, roomId: string, first24h: boolean): Promise<void> {
    const gapMs = first24h ? 5000 : 3000;
    await this.limiter.incr(`ratelimit:${actorId}:room_say:min`, 60);
    await this.limiter.incr(`ratelimit:${actorId}:write:min`, 60);
    await this.limiter.incr(`ratelimit:${actorId}:room:${roomId}:say:min`, 60);
    await this.limiter.setPx(`ratelimit:${actorId}:room_say:gap`, "1", gapMs);
  }

  async consumeWrite(actorId: string, first24h: boolean): Promise<void> {
    const limit = first24h ? 15 : 30;
    const key = `ratelimit:${actorId}:write:min`;
    const n = await this.limiter.incr(key, 60);
    if (n > limit) {
      await this.refuse(first24h ? "write_new" : "write", key, limit, n, 60_000, "Write rate limiter exhausted.");
    }
  }

  async consumeRead(actorId: string): Promise<void> {
    const limit = 60;
    const key = `ratelimit:${actorId}:read:min`;
    const n = await this.limiter.incr(key, 60);
    if (n > limit) {
      await this.refuse("read", key, limit, n, 60_000, "Read rate limiter exhausted.");
    }
  }

  async consumeMove(actorId: string): Promise<void> {
    const gapMs = 3000;
    const gapKey = `ratelimit:${actorId}:move:gap`;
    if (await this.limiter.exists(gapKey)) {
      await this.refuse("move", gapKey, 1, 1, gapMs, "Move cooldown.");
    }
    const key = `ratelimit:${actorId}:move:5min`;
    const n = await this.limiter.incr(key, 300);
    if (n > 20) {
      await this.refuse("move", key, 20, n, 300_000, "Move rate limiter exhausted.");
    }
    await this.limiter.setPx(gapKey, "1", gapMs);
  }

  async consumeEnter(humanId: string): Promise<void> {
    const key = `ratelimit:${humanId}:enter:hour`;
    const n = await this.limiter.incr(key, HOUR);
    if (n > 10) {
      await this.refuse("enter", key, 10, n, HOUR * 1000, "Enter rate limiter exhausted.");
    }
  }

  async consumeRegister(ip: string): Promise<void> {
    const hourKey = `ratelimit:ip:${ip}:register:hour`;
    const hour = await this.limiter.incr(hourKey, HOUR);
    if (hour > 3) {
      await this.refuse(
        "register",
        hourKey,
        3,
        hour,
        HOUR * 1000,
        "Register rate limiter exhausted (3 per IP per hour).",
      );
    }
    const dayKey = `ratelimit:ip:${ip}:register:day`;
    const day = await this.limiter.incr(dayKey, DAY);
    if (day > 10) {
      await this.refuse(
        "register",
        dayKey,
        10,
        day,
        DAY * 1000,
        "Register rate limiter exhausted (10 per IP per day).",
      );
    }
  }

  async consumeMagicLink(email: string): Promise<void> {
    const key = `ratelimit:email:${email.toLowerCase()}:magic:hour`;
    const n = await this.limiter.incr(key, HOUR);
    if (n > 5) {
      await this.refuse("magic_link", key, 5, n, HOUR * 1000, "Magic link rate limiter exhausted.");
    }
  }

  async consumeWhisper(actorId: string, first24h: boolean): Promise<void> {
    const limit = first24h ? 10 : 20;
    const key = `ratelimit:${actorId}:whisper:min`;
    const n = await this.limiter.incr(key, 60);
    if (n > limit) {
      await this.refuse(first24h ? "whisper_new" : "whisper", key, limit, n, 60_000, "Whisper rate limiter exhausted.");
    }
  }

  /** Pulse is cheap but must not become a firehose: 1/s per actor. */
  async consumePulse(actorId: string): Promise<void> {
    const gapMs = 1000;
    const key = `ratelimit:${actorId}:pulse:gap`;
    if (await this.limiter.exists(key)) {
      await this.refuse("pulse", key, 1, 1, gapMs, "Pulse cooldown (1 per second).");
    }
    await this.limiter.setPx(key, "1", gapMs);
  }

  /**
   * Tool-call span reports (start / progress / finish). Deliberately NOT the
   * 1/s pulse gap: a fast tool's start and finish land in the same second, and
   * refusing the finish would leave the call looking like it never ended.
   * 60 per 10 seconds covers a busy Claude Code turn (two reports per call,
   * parallel calls included) and still stops a runaway loop.
   */
  async consumeToolCall(actorId: string): Promise<void> {
    const limit = 60;
    const key = `ratelimit:${actorId}:tool_call:10s`;
    const n = await this.limiter.incr(key, 10);
    if (n > limit) {
      await this.refuse("tool_call", key, limit, n, 10_000, "Tool-call report limiter exhausted (60 per 10 seconds).");
    }
  }

  /**
   * Usage reports (migration 024). A runtime reports once per turn, or once
   * per model per turn when it batches; 30 requests a minute is a busy agent
   * with room to spare, and refuses only a loop reporting per token.
   */
  async consumeUsage(actorId: string): Promise<void> {
    const key = `ratelimit:${actorId}:usage:min`;
    const n = await this.limiter.incr(key, 60);
    if (n > 30) {
      await this.refuse("usage", key, 30, n, 60_000, "Usage report rate limiter exhausted (30 per minute).");
    }
  }

  /**
   * Asking to join a space. Cheap to send, expensive to read: an owner should
   * never be able to be buried. Two windows, same shape as consumeRegister —
   * a burst cap and a daily cap — and the daily one is tighter in the first 24h
   * because a fresh account asking twenty spaces at once is what abuse looks
   * like, not what a new member does.
   */
  async consumeJoinRequest(humanId: string, first24h: boolean): Promise<void> {
    const hourKey = `ratelimit:${humanId}:join_request:hour`;
    const hour = await this.limiter.incr(hourKey, HOUR);
    if (hour > 3) {
      await this.refuse(
        "join_request",
        hourKey,
        3,
        hour,
        HOUR * 1000,
        "Join request rate limiter exhausted (3 per hour).",
      );
    }
    const dayLimit = first24h ? 5 : 10;
    const dayKey = `ratelimit:${humanId}:join_request:day`;
    const day = await this.limiter.incr(dayKey, DAY);
    if (day > dayLimit) {
      await this.refuse(
        first24h ? "join_request_new" : "join_request",
        dayKey,
        dayLimit,
        day,
        DAY * 1000,
        `Join request rate limiter exhausted (${dayLimit} per day).`,
      );
    }
  }

  async consumeReport(actorId: string, first24h: boolean): Promise<void> {
    const limit = first24h ? 5 : 10;
    const key = `ratelimit:${actorId}:report:day`;
    const n = await this.limiter.incr(key, DAY);
    if (n > limit) {
      await this.refuse("report", key, limit, n, DAY * 1000, "Report rate limiter exhausted.");
    }
  }
}
