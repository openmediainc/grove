import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

function forCloudPostgres(databaseUrl: string): boolean {
  return databaseUrl.includes("supabase.co") || databaseUrl.includes("pooler.supabase.com");
}

/** Strip sslmode so pg's newer verify-full default cannot override our ssl config. */
function connectionString(databaseUrl: string): string {
  return databaseUrl.replace(/[?&]sslmode=[^&]*/g, "").replace(/\?$/, "").replace("?&", "?");
}

type Env = Record<string, string | undefined>;

/** Supavisor: session mode on 5432 (hard client cap = pool_size), transaction mode on 6543. */
export const SUPABASE_SESSION_PORT = "5432";
export const SUPABASE_TRANSACTION_PORT = "6543";

/** Last `@host[:port]` authority in a postgres URL (the password may itself contain '@' only if encoded). */
function authority(url: string): { start: number; end: number; host: string; port: string | null } | null {
  const re = /@([A-Za-z0-9.-]+)(?::(\d+))?(?=[/?#]|$)/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(url); m; m = re.exec(url)) last = m;
  if (!last) return null;
  return { start: last.index, end: last.index + last[0].length, host: last[1]!, port: last[2] ?? null };
}

function withPort(url: string, port: string): string {
  const a = authority(url);
  if (!a) return url;
  return `${url.slice(0, a.start)}@${a.host}:${port}${url.slice(a.end)}`;
}

function isSupabasePooler(host: string): boolean {
  return host.toLowerCase().endsWith(".pooler.supabase.com");
}

/**
 * The URL the normal query Pool should use.
 *
 * Supabase's session pooler (port 5432) caps clients at pool_size (15) across
 * every serverless instance, so on Vercel — or whenever
 * `DATABASE_POOL_MODE=transaction` — a `*.pooler.supabase.com:5432` URL is
 * moved to the transaction pooler (6543). `DATABASE_POOL_MODE=session` pins it.
 * Anything else (local Docker, direct `db.*.supabase.co`, the migration runner
 * off Vercel) is returned untouched.
 */
export function poolUrl(databaseUrl: string, env: Env = process.env): string {
  const mode = (env.DATABASE_POOL_MODE ?? "").toLowerCase();
  if (mode === "session") return databaseUrl;
  if (mode !== "transaction" && !env.VERCEL) return databaseUrl;
  const a = authority(databaseUrl);
  if (!a || !isSupabasePooler(a.host)) return databaseUrl;
  if ((a.port ?? SUPABASE_SESSION_PORT) !== SUPABASE_SESSION_PORT) return databaseUrl;
  return withPort(databaseUrl, SUPABASE_TRANSACTION_PORT);
}

/**
 * The URL for a session-bound connection (LISTEN). LISTEN does not survive the
 * transaction pooler, so a Supabase pooler URL on 6543 is moved back to 5432.
 */
export function sessionUrl(databaseUrl: string): string {
  const a = authority(databaseUrl);
  if (!a || !isSupabasePooler(a.host)) return databaseUrl;
  if (a.port !== SUPABASE_TRANSACTION_PORT) return databaseUrl;
  return withPort(databaseUrl, SUPABASE_SESSION_PORT);
}

export function pgSsl(databaseUrl: string): { rejectUnauthorized: false } | undefined {
  return forCloudPostgres(databaseUrl) ? { rejectUnauthorized: false } : undefined;
}

export { connectionString as stripSslMode };

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: connectionString(poolUrl(databaseUrl)),
    max: Number(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 3 : 20)),
    ssl: pgSsl(databaseUrl),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 8000),
  });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
