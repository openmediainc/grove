import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../migrations");

/** Every migration on disk, in the order they must be applied. */
function migrationFiles(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * The ids already recorded in schema_migrations.
 *
 * Read-only on purpose: if the ledger table does not exist yet this reports an
 * empty set rather than creating it, so a caller that only wants to *look* (see
 * pendingMigrations) never writes to the database it is inspecting.
 */
async function appliedIds(pool: pg.Pool): Promise<Set<string>> {
  const exists = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS reg",
  );
  if (!exists.rows[0]?.reg) return new Set();
  const applied = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(applied.rows.map((r) => r.id));
}

/**
 * Which migrations would run, without running any of them.
 *
 * Nothing here writes: no ledger table is created and no SQL file is read into
 * the database. This is what lets the API boot with migrations OFF and still
 * tell an operator, by id, what a deliberate `pnpm migrate` would apply.
 */
export async function pendingMigrations(databaseUrl: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const done = await appliedIds(pool);
    return migrationFiles().filter((file) => !done.has(file));
  } finally {
    await pool.end();
  }
}

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const done = await appliedIds(pool);
    for (const file of migrationFiles()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await pool.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL ?? "postgres://grove:grove@localhost:5432/grove";
  migrate(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
