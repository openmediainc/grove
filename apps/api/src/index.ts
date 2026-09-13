import Fastify from "fastify";
import { GroveApp, createPool, createBus, loadConfig, migrate, pendingMigrations } from "@grove/domain";
import { buildApp } from "./create-app.js";
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
    if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
      await prepareSchema(config.databaseUrl, config.migrateOnBoot);
    }
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

    if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
      setInterval(() => {
        void grove.presence.evictStale();
        void grove.toolCalls.sweep().catch(() => {});
        void grove.identity.purgeExpiredUnclaimed();
      }, 60_000);
      setInterval(() => {
        void grove.jobs.processDue();
      }, 15_000);
      // ONB-07: ask the mail provider what became of accepted magic links. Outbound
      // only, and a no-op for transports without an events API.
      setInterval(() => {
        void grove.emailDeliveries.pollDue().catch((err) => console.warn("[grove] email poll failed:", (err as Error).message));
      }, 30_000);
      setInterval(() => {
        if (!config.xaiApiKey) return;
        void grove.brains.tick();
      }, 20_000);
    }

    return app;
  })();
  return appPromise;
}

const serverless = Boolean(
  process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME,
);

async function localListen() {
  const app = await getApp();
  const config = loadConfig();
  await app.listen({ port: config.apiPort, host: config.listenHost });
  console.log(`[grove] api http://${config.listenHost}:${config.apiPort}`);
}

const { createServer } = await import("node:http");
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/health" || url.startsWith("/health?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "up" }));
    return;
  }
  void getApp()
    .then(async (app) => {
      await app.ready();
      app.server.emit("request", req, res);
    })
    .catch((err) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }));
    });
});

void Fastify;
export default server;

if (!serverless) {
  await localListen();
}
