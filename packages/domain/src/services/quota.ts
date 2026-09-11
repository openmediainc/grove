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

export class QuotaService {
  constructor(private limiter: RateLimiter) {}

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
    const n = await this.limiter.incr(`ratelimit:${actorId}:write:min`, 60);
    if (n > limit) {
      throw new GroveError("RATE_LIMITED", "Write rate limiter exhausted.");
    }
  }

  async consumeRead(actorId: string): Promise<void> {
    const n = await this.limiter.incr(`ratelimit:${actorId}:read:min`, 60);
    if (n > 60) throw new GroveError("RATE_LIMITED", "Read rate limiter exhausted.");
  }

  async consumeMove(actorId: string): Promise<void> {
    if (await this.limiter.exists(`ratelimit:${actorId}:move:gap`)) {
      throw new GroveError("RATE_LIMITED", "Move cooldown.");
    }
    const n = await this.limiter.incr(`ratelimit:${actorId}:move:5min`, 300);
    if (n > 20) throw new GroveError("RATE_LIMITED", "Move rate limiter exhausted.");
    await this.limiter.setPx(`ratelimit:${actorId}:move:gap`, "1", 3000);
  }

  async consumeEnter(humanId: string): Promise<void> {
    const n = await this.limiter.incr(`ratelimit:${humanId}:enter:hour`, HOUR);
    if (n > 10) throw new GroveError("RATE_LIMITED", "Enter rate limiter exhausted.");
  }

  async consumeRegister(ip: string): Promise<void> {
    const hour = await this.limiter.incr(`ratelimit:ip:${ip}:register:hour`, HOUR);
    if (hour > 3) {
      throw new GroveError("RATE_LIMITED", "Register rate limiter exhausted (3 per IP per hour).");
    }
    const day = await this.limiter.incr(`ratelimit:ip:${ip}:register:day`, DAY);
    if (day > 10) {
      throw new GroveError("RATE_LIMITED", "Register rate limiter exhausted (10 per IP per day).");
    }
  }

  async consumeMagicLink(email: string): Promise<void> {
    const n = await this.limiter.incr(`ratelimit:email:${email.toLowerCase()}:magic:hour`, HOUR);
    if (n > 5) throw new GroveError("RATE_LIMITED", "Magic link rate limiter exhausted.");
  }

  async consumeWhisper(actorId: string, first24h: boolean): Promise<void> {
    const limit = first24h ? 10 : 20;
    const n = await this.limiter.incr(`ratelimit:${actorId}:whisper:min`, 60);
    if (n > limit) throw new GroveError("RATE_LIMITED", "Whisper rate limiter exhausted.");
  }

  async consumeReport(actorId: string, first24h: boolean): Promise<void> {
    const limit = first24h ? 5 : 10;
    const n = await this.limiter.incr(`ratelimit:${actorId}:report:day`, DAY);
    if (n > limit) throw new GroveError("RATE_LIMITED", "Report rate limiter exhausted.");
  }
}
