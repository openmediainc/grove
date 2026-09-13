import type { GroveApp } from "@grove/domain";

let lastTick = 0;
const TICK_MS = 15_000;

export async function runTick(grove: GroveApp): Promise<void> {
  await grove.presence.evictStale();
  await grove.toolCalls.sweep().catch(() => {});
  await grove.identity.purgeExpiredUnclaimed();
  await grove.jobs.processDue();
  await grove.emailDeliveries.pollDue().catch(() => {});
  if (grove.store.config.xaiApiKey) await grove.brains.tick();
}

export function maybeTick(grove: GroveApp): void {
  const now = Date.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;
  void runTick(grove).catch((err) => {
    console.warn("[grove] tick failed:", (err as Error).message);
  });
}
