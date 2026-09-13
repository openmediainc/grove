import { EventEmitter } from "node:events";
import Redis from "ioredis";
import pg from "pg";
import type { Pool } from "./db.js";

function pgChannel(name: string): string {
  const hex = Buffer.from(name, "utf8").toString("hex");
  return `g_${hex.slice(0, 61)}`;
}

function parseSetArgs(args: (string | number)[]): { ex?: number; px?: number; nx: boolean } {
  let ex: number | undefined;
  let px: number | undefined;
  let nx = false;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]).toUpperCase();
    if (a === "EX") ex = Number(args[++i]);
    else if (a === "PX") px = Number(args[++i]);
    else if (a === "NX") nx = true;
  }
  return { ex, px, nx };
}

function expiresSql(ex?: number, px?: number): string | null {
  if (px != null) return `now() + (${px} * interval '1 millisecond')`;
  if (ex != null) return `now() + (${ex} * interval '1 second')`;
  return null;
}

/** ioredis-shaped bus backed by Postgres so Grove can run without Redis. */
export class PgRedis extends EventEmitter {
  private listenClient: pg.Client | null = null;
  private listenReady: Promise<void> | null = null;
  private subscribed = new Set<string>();

  constructor(
    private pool: Pool,
    private connectionString: string,
  ) {
    super();
    this.setMaxListeners(50);
  }

  async ping(): Promise<string> {
    await this.pool.query("SELECT 1");
    return "PONG";
  }

  private async purge(): Promise<void> {
    await this.pool.query("DELETE FROM grove_kv WHERE expires_at IS NOT NULL AND expires_at < now()");
    await this.pool.query("DELETE FROM grove_set WHERE expires_at IS NOT NULL AND expires_at < now()");
  }

  async get(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ value: string }>(
      "SELECT value FROM grove_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())",
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    const { ex, px, nx } = parseSetArgs(args);
    const exp = expiresSql(ex, px);
    if (nx) {
      const sql = exp
        ? `INSERT INTO grove_kv (key, value, expires_at) VALUES ($1, $2, ${exp})
           ON CONFLICT (key) DO NOTHING`
        : `INSERT INTO grove_kv (key, value, expires_at) VALUES ($1, $2, NULL)
           ON CONFLICT (key) DO NOTHING`;
      const res = await this.pool.query(sql, [key, value]);
      return res.rowCount === 1 ? "OK" : null;
    }
    const sql = exp
      ? `INSERT INTO grove_kv (key, value, expires_at) VALUES ($1, $2, ${exp})
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`
      : `INSERT INTO grove_kv (key, value, expires_at) VALUES ($1, $2, NULL)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`;
    await this.pool.query(sql, [key, value]);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    const flat = keys.flat();
    if (!flat.length) return 0;
    const kv = await this.pool.query("DELETE FROM grove_kv WHERE key = ANY($1::text[])", [flat]);
    const st = await this.pool.query("DELETE FROM grove_set WHERE key = ANY($1::text[])", [flat]);
    return (kv.rowCount ?? 0) + (st.rowCount ?? 0);
  }

  async incr(key: string): Promise<number> {
    const { rows } = await this.pool.query<{ value: string }>(
      `INSERT INTO grove_kv (key, value) VALUES ($1, '1')
       ON CONFLICT (key) DO UPDATE SET value = (COALESCE(grove_kv.value, '0')::int + 1)::text
       RETURNING value`,
      [key],
    );
    return Number(rows[0]?.value ?? "1");
  }

  async expire(key: string, seconds: number): Promise<number> {
    const kv = await this.pool.query(
      "UPDATE grove_kv SET expires_at = now() + ($2 * interval '1 second') WHERE key = $1",
      [key, seconds],
    );
    const st = await this.pool.query(
      "UPDATE grove_set SET expires_at = now() + ($2 * interval '1 second') WHERE key = $1",
      [key, seconds],
    );
    return (kv.rowCount ?? 0) > 0 || (st.rowCount ?? 0) > 0 ? 1 : 0;
  }

  async pttl(key: string): Promise<number> {
    const { rows } = await this.pool.query<{ ms: string | null }>(
      `SELECT CASE WHEN expires_at IS NULL THEN -1
                  WHEN expires_at <= now() THEN -2
                  ELSE FLOOR(EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::text
             END AS ms
       FROM grove_kv WHERE key = $1`,
      [key],
    );
    if (!rows[0]) return -2;
    return Number(rows[0].ms);
  }

  async exists(key: string): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM grove_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now()) LIMIT 1",
      [key],
    );
    return rows.length ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    const res = await this.pool.query(
      "INSERT INTO grove_set (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [key, member],
    );
    return res.rowCount ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ member: string }>(
      "SELECT member FROM grove_set WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())",
      [key],
    );
    return rows.map((r) => r.member);
  }

  async srem(key: string, member: string): Promise<number> {
    const res = await this.pool.query("DELETE FROM grove_set WHERE key = $1 AND member = $2", [key, member]);
    return res.rowCount ?? 0;
  }

  async getset(key: string, value: string): Promise<string | null> {
    const prev = await this.get(key);
    await this.set(key, value);
    return prev;
  }

  async keys(pattern: string): Promise<string[]> {
    const like = pattern.replace(/([%_])/g, "\\$1").replace(/\*/g, "%").replace(/\?/g, "_");
    const { rows } = await this.pool.query<{ key: string }>(
      "SELECT key FROM grove_kv WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > now())",
      [like],
    );
    return rows.map((r) => r.key);
  }

  async eval(script: string, _numKeys: number, key: string, argv: string): Promise<number> {
    // The only script Grove ships: delete key if value matches.
    void script;
    const res = await this.pool.query("DELETE FROM grove_kv WHERE key = $1 AND value = $2", [key, argv]);
    return res.rowCount ?? 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    let payload = message;
    if (Buffer.byteLength(payload) > 7000) {
      const id = `pub:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await this.set(id, message, "EX", 60);
      payload = `__kv:${id}`;
    }
    await this.pool.query("SELECT pg_notify($1, $2)", [pgChannel(channel), payload]);
    return 1;
  }

  duplicate(): PgRedis {
    return new PgRedis(this.pool, this.connectionString);
  }

  async subscribe(...channels: string[]): Promise<number> {
    await this.ensureListen();
    for (const ch of channels) {
      this.subscribed.add(ch);
      await this.listenClient!.query(`LISTEN ${pgChannel(ch)}`);
    }
    return channels.length;
  }

  private async ensureListen(): Promise<void> {
    if (this.listenReady) return this.listenReady;
    this.listenReady = (async () => {
      const cloud =
        this.connectionString.includes("supabase.co") ||
        this.connectionString.includes("pooler.supabase.com");
      const url = this.connectionString.replace(/[?&]sslmode=[^&]*/g, "").replace(/\?$/, "");
      const client = new pg.Client({
        connectionString: url,
        ssl: cloud ? { rejectUnauthorized: false } : undefined,
      });
      await client.connect();
      client.on("notification", async (msg) => {
        const mapped = [...this.subscribed].find((c) => pgChannel(c) === msg.channel);
        if (!mapped) return;
        let payload = msg.payload ?? "";
        if (payload.startsWith("__kv:")) {
          payload = (await this.get(payload.slice(5))) ?? payload;
        }
        this.emit("message", mapped, payload);
      });
      this.listenClient = client;
    })();
    return this.listenReady;
  }

  async quit(): Promise<string> {
    if (this.listenClient) {
      await this.listenClient.end().catch(() => {});
      this.listenClient = null;
      this.listenReady = null;
    }
    return "OK";
  }

  disconnect(): void {
    void this.quit();
  }

  async sweepExpired(): Promise<void> {
    await this.purge();
  }
}

export function createBus(pg: Pool, redisUrl: string, databaseUrl: string): Redis {
  if (redisUrl === "pg" || redisUrl === "postgres" || redisUrl === "memory://pg") {
    return new PgRedis(pg, databaseUrl) as unknown as Redis;
  }
  return new Redis(redisUrl);
}
