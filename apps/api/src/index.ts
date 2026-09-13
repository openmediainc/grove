import { GroveApp, createPool, createBus, loadConfig, migrate, pendingMigrations } from "@grove/domain";
import { buildApp } from "./app.js";
import { maybeTick, runTick } from "./tick.js";

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

let appPromise: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;

export async function getApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const config = loadConfig();
    await prepareSchema(config.databaseUrl, config.migrateOnBoot || Boolean(process.env.VERCEL));
    const pg = createPool(config.databaseUrl);
    const redis = createBus(pg, config.redisUrl, config.databaseUrl);
    const grove = new GroveApp(pg, redis, config);
    const app = await buildApp(grove);

    app.addHook("onRequest", async () => {
      maybeTick(grove);
    });

    app.get("/api/v1/internal/tick", async (req, reply) => {
      const secret = process.env.CRON_SECRET;
      if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return reply.status(401).send({ ok: false });
      }
      await runTick(grove);
      return { ok: true };
    });

    if (!process.env.VERCEL) {
      setInterval(() => {
        void grove.presence.evictStale();
        void grove.toolCalls.sweep().catch(() => {});
        void grove.identity.purgeExpiredUnclaimed();
      }, 60_000);
      setInterval(() => {
        void grove.jobs.processDue();
      }, 15_000);
      setInterval(() => {
        if (!config.xaiApiKey) return;
        void grove.brains.tick();
      }, 20_000);
    }

    return app;
  })();
  return appPromise;
}

const app = await getApp();
export default app;

if (!process.env.VERCEL) {
  const config = loadConfig();
  await app.listen({ port: config.apiPort, host: config.listenHost });
  console.log(`[grove] api http://${config.listenHost}:${config.apiPort}`);
}
