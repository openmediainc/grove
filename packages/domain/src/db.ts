import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): pg.Pool {
  const supabase = databaseUrl.includes("supabase.co") || databaseUrl.includes("pooler.supabase.com");
  return new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 3 : 20)),
    ssl: supabase ? { rejectUnauthorized: false } : undefined,
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
