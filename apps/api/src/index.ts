import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate, pendingMigrations } from "@grove/domain";
import { buildApp } from "./app.js";

/**
 * Bring the schema into line with the code, or say plainly that it is not.
 *
 * Boot migrations are OFF unless GROVE_MIGRATE_ON_BOOT=1. A service that
 * migrates on every start applies whatever .sql happens to be sitting in
 * packages/domain/migrations the next time launchd or the watchdog bounces it —
 * including a migration somebody is halfway through writing.
 *
 * With the flag off we still LOOK, and name what we did not apply, so the gap
 * is discovered at startup rather than through a runtime error hours later.
 * With the flag on, a failure is fatal: serving on a schema that does not match
 * the code is worse than not serving at all.
 */
async function prepareSchema(databaseUrl: string, migrateOnBoot: boolean): Promise<void> {
  if (migrateOnBoot) {
    try {
      await migrate(databaseUrl);
    } catch (err) {
      console.error(
        `[grove] FATAL: migration failed: ${(err as Error).message}\n` +
          "[grove] refusing to serve on a schema that does not match the code.",
      );
      process.exit(1);
    }
    return;
  }

  let pending: string[];
  try {
    pending = await pendingMigrations(databaseUrl);
  } catch (err) {
    // Could not even look. Not fatal on its own — the pool below will fail loudly
    // if the database is genuinely unreachable — but never silent.
    console.warn(`[grove] could not check for pending migrations: ${(err as Error).message}`);
    return;
  }
  if (!pending.length) return;

  const plural = pending.length === 1 ? "migration" : "migrations";
  console.warn(
    [
      "",
      "================================================================",
      `[grove] WARNING: ${pending.length} ${plural} on disk are NOT applied to this database:`,
      ...pending.map((id) => `[grove]   - ${id}`),
      "[grove] Boot migrations are OFF (set GROVE_MIGRATE_ON_BOOT=1 to change that).",
      "[grove] The API is starting on the schema as it stands, so anything the",
      "[grove] code expects from those files will fail at runtime.",
      "[grove] Apply them deliberately with:  pnpm migrate",
      "================================================================",
      "",
    ].join("\n"),
  );
}

async function main() {
  const config = loadConfig();
  await prepareSchema(config.databaseUrl, config.migrateOnBoot);
  const pg = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const grove = new GroveApp(pg, redis, config);

  setInterval(() => {
    void grove.presence.evictStale();
    void grove.toolCalls.sweep().catch(() => {});
    void grove.identity.purgeExpiredUnclaimed();
  }, 60_000);

  setInterval(() => {
    void grove.jobs.processDue();
  }, 15_000);

  // ONB-07: ask the mail provider what became of accepted magic links. Outbound
  // only (Grove is tailnet-only, so provider webhooks cannot reach it). A no-op
  // for transports without an events API.
  setInterval(() => {
    void grove.emailDeliveries.pollDue().catch((err) => console.warn("[grove] email poll failed:", (err as Error).message));
  }, 30_000);

  // Hosted xAI ticks stay off unless XAI_API_KEY is set. Mini-alpha inhabitants
  // are local HTTP bots (infra/inhabitants) so Grok tokens are not burned on empty rooms.
  setInterval(() => {
    if (!config.xaiApiKey) return;
    void grove.brains.tick();
  }, 20_000);

  const app = await buildApp(grove);
  await app.listen({ port: config.apiPort, host: config.listenHost });
  console.log(`[grove] api http://${config.listenHost}:${config.apiPort}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
