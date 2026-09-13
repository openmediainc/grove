import { EventEmitter } from "node:events";
import Redis from "ioredis";
import pg from "pg";
import { pgSsl, sessionUrl, stripSslMode, type Pool } from "./db.js";

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

/** The slice of pg.Client the shared listener uses (a fake in unit tests). */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", fn: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error" | "end", fn: (err?: Error) => void): unknown;
}

export type ListenClientFactory = (connectionString: string) => ListenClient;

const defaultListenFactory: ListenClientFactory = (connectionString) => {
  const url = sessionUrl(connectionString);
  return new pg.Client({
    connectionString: stripSslMode(url),
    ssl: pgSsl(url),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 8000),
  }) as unknown as ListenClient;
};

export const LISTEN_IDLE_CLOSE_MS = 60_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/**
 * ONE LISTEN connection per process per connection string, shared by every
 * PgRedis (and every duplicate()). Each realtime stream used to open its own
 * session-pooler connection; a few tabs across a few serverless instances then
 * exhausted Supabase's 15-client session cap and took the query pool down too.
 *
 * Channels are refcounted by subscriber: LISTEN on the first, UNLISTEN when the
 * last one leaves. With no channels for LISTEN_IDLE_CLOSE_MS the connection is
 * ended, so an idle serverless instance does not pin a session slot. A dropped
 * connection reconnects with backoff and re-LISTENs everything.
 */
export class SharedListener {
  private client: ListenClient | null = null;
  private connecting: Promise<ListenClient> | null = null;
  private readonly channels = new Map<string, Set<PgRedis>>();
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_MIN_MS;
  /** Connections opened so far (tests/diagnostics). */
  opened = 0;

  constructor(
    private readonly connectionString: string,
    private readonly factory: ListenClientFactory,
    private readonly idleCloseMs = LISTEN_IDLE_CLOSE_MS,
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  channelCount(): number {
    return this.channels.size;
  }

  subscriberCount(pgName: string): number {
    return this.channels.get(pgName)?.size ?? 0;
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => {});
    return next;
  }

  async add(sub: PgRedis, pgName: string): Promise<void> {
    return this.serial(async () => {
      this.clearIdle();
      let subs = this.channels.get(pgName);
      const fresh = !subs;
      if (!subs) {
        subs = new Set();
        this.channels.set(pgName, subs);
      }
      subs.add(sub);
      try {
        const hadClient = this.client !== null;
        const client = await this.ensureClient();
        // A fresh connection has already LISTENed every channel in the map.
        if (fresh && hadClient) await client.query(`LISTEN ${pgName}`);
      } catch (err) {
        subs.delete(sub);
        if (!subs.size) this.channels.delete(pgName);
        this.maybeIdle();
        throw err;
      }
    });
  }

  async remove(sub: PgRedis, pgName: string): Promise<void> {
    return this.serial(async () => {
      const subs = this.channels.get(pgName);
      if (!subs || !subs.delete(sub)) return;
      if (subs.size) return;
      this.channels.delete(pgName);
      if (this.client) await this.client.query(`UNLISTEN ${pgName}`).catch(() => {});
      this.maybeIdle();
    });
  }

  private async ensureClient(): Promise<ListenClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = this.factory(this.connectionString);
      client.on("notification", (msg) => this.dispatch(msg.channel, msg.payload ?? ""));
      const lost = () => this.onLost(client);
      client.on("error", lost);
      client.on("end", lost);
      try {
        await client.connect();
        this.opened++;
        for (const name of this.channels.keys()) await client.query(`LISTEN ${name}`);
      } catch (err) {
        await client.end().catch(() => {});
        throw err;
      }
      this.client = client;
      this.backoff = BACKOFF_MIN_MS;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private dispatch(pgName: string, payload: string): void {
    const subs = this.channels.get(pgName);
    if (!subs) return;
    for (const sub of subs) sub.deliver(pgName, payload);
  }

  private onLost(client: ListenClient): void {
    if (this.client !== client) return;
    this.client = null;
    void client.end().catch(() => {});
    if (this.channels.size) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.channels.size || this.client) return;
      void this.serial(() => this.ensureClient()).catch(() => this.scheduleReconnect());
    }, wait);
    this.retryTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private maybeIdle(): void {
    if (this.channels.size || this.idleTimer) return;
    if (!this.client && !this.connecting) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.serial(async () => {
        if (this.channels.size) return;
        await this.close();
      });
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /** End the connection now (idle close, or tests). */
  async close(): Promise<void> {
    this.clearIdle();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }
}

const listeners = new Map<string, SharedListener>();
let listenFactory: ListenClientFactory = defaultListenFactory;
let listenIdleOverride: number | null = null;

/** The process-wide listener for a connection string. */
export function sharedListener(connectionString: string): SharedListener {
  const key = sessionUrl(connectionString);
  let l = listeners.get(key);
  if (!l) {
    l = new SharedListener(key, (cs) => listenFactory(cs), listenIdleOverride ?? LISTEN_IDLE_CLOSE_MS);
    listeners.set(key, l);
  }
  return l;
}

/** LISTEN connections open for a database across all subscribers (0 or 1). */
export function listenConnections(connectionString: string): number {
  return listeners.get(sessionUrl(connectionString))?.connected ? 1 : 0;
}

/** Tests only: swap the client factory and drop cached listeners. */
export function __setListenClientFactory(factory: ListenClientFactory | null, idleCloseMs?: number): void {
  for (const l of listeners.values()) void l.close();
  listeners.clear();
  listenFactory = factory ?? defaultListenFactory;
  listenIdleOverride = idleCloseMs ?? null;
}

/** ioredis-shaped bus backed by Postgres so Grove can run without Redis. */
export class PgRedis extends EventEmitter {
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

  private listener(): SharedListener {
    return sharedListener(this.connectionString);
  }

  async subscribe(...channels: string[]): Promise<number> {
    for (const ch of channels) {
      if (this.subscribed.has(ch)) continue;
      this.subscribed.add(ch);
      try {
        await this.listener().add(this, pgChannel(ch));
      } catch (err) {
        this.subscribed.delete(ch);
        throw err;
      }
    }
    return this.subscribed.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    const targets = channels.length ? channels : [...this.subscribed];
    for (const ch of targets) {
      if (!this.subscribed.delete(ch)) continue;
      // Another channel name of ours may hash to the same (truncated) pg name.
      const name = pgChannel(ch);
      if ([...this.subscribed].some((c) => pgChannel(c) === name)) continue;
      await this.listener().remove(this, name);
    }
    return this.subscribed.size;
  }

  /** Called by the shared listener for a pg channel this instance is on. */
  deliver(pgName: string, raw: string): void {
    const mapped = [...this.subscribed].filter((c) => pgChannel(c) === pgName);
    if (!mapped.length) return;
    void (async () => {
      let payload = raw;
      if (payload.startsWith("__kv:")) {
        payload = (await this.get(payload.slice(5)).catch(() => null)) ?? payload;
      }
      for (const ch of mapped) this.emit("message", ch, payload);
    })();
  }

  /** Leaves this instance's channels; the shared connection stays for others. */
  async quit(): Promise<string> {
    await this.unsubscribe().catch(() => {});
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
  const usePg =
    !redisUrl ||
    redisUrl === "pg" ||
    redisUrl === "postgres" ||
    redisUrl === "memory://pg" ||
    (Boolean(process.env.VERCEL) && redisUrl.includes("localhost"));
  if (usePg) {
    return new PgRedis(pg, databaseUrl) as unknown as Redis;
  }
  return new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: false });
}
