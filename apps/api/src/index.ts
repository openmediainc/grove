import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  if (process.env.GROVE_MIGRATE !== "0") {
    try {
      await migrate(config.databaseUrl);
    } catch (err) {
      console.warn("[grove] migrate skipped or failed:", (err as Error).message);
    }
  }
  const pg = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const grove = new GroveApp(pg, redis, config);

  setInterval(() => {
    void grove.presence.evictStale();
    void grove.identity.purgeExpiredUnclaimed();
  }, 60_000);

  setInterval(() => {
    void grove.jobs.processDue();
  }, 15_000);

  setInterval(() => {
    if (!config.xaiApiKey) return;
    void grove.brains.tick();
  }, 20_000);

  const app = await buildApp(grove);
  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`[grove] api http://localhost:${config.apiPort}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
