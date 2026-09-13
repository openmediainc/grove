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

export function createPool(databaseUrl: string): pg.Pool {
  const cloud = forCloudPostgres(databaseUrl);
  return new pg.Pool({
    connectionString: connectionString(databaseUrl),
    max: Number(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 3 : 20)),
    ssl: cloud ? { rejectUnauthorized: false } : undefined,
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
