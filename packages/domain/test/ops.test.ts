/**
 * OPS-01 — the operator overview's anomaly lines.
 *
 * The rules and the wording are pure and tested first: an operator acts on the
 * sentence, so the sentence is the contract. The database half proves the one
 * statement buckets rows into the right trailing-day window and that one broken
 * section cannot blank the rest of the page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  OPS_METRICS,
  anomaliesFor,
  detectAnomaly,
  formatRatio,
  median,
  metricsFromRows,
  opsMetricsSql,
  windowsFrom,
  type MetricDef,
} from "../src/services/ops.js";
import { assertTestDatabase, hasTestDatabase, warnIfNotTestDatabase } from "./support/fixtures.js";

const def = (key: string): MetricDef => {
  const m = OPS_METRICS.find((x) => x.key === key);
  if (!m) throw new Error(`no metric ${key}`);
  return m;
};

describe("anomaly rules and wording", () => {
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("formats ratios plainly", () => {
    expect(formatRatio(2.96)).toBe("3");
    expect(formatRatio(2.5)).toBe("2.5");
    expect(formatRatio(14.2)).toBe("14");
  });

  it("windows are zero-filled and the median skips the current window", () => {
    const w = windowsFrom([42, 14], 6);
    expect(w.days).toEqual([42, 14, 0, 0, 0, 0, 0, 0]);
    expect(w.current).toBe(42);
    expect(w.previous).toBe(14);
    expect(w.median).toBe(0);
    expect(windowsFrom([9, 10, 12, 11, 13, 9, 10, 99], 6).median).toBe(10.5);
    expect(windowsFrom([9, 10, 12, 11, 13, 9, 10, 99], 7).median).toBe(11);
  });

  it("says 'tool-call errors up 3× vs yesterday'", () => {
    const line = detectAnomaly(def("tool_call_errors"), windowsFrom([42, 14, 12, 12, 13, 11, 12], 6));
    expect(line).not.toBeNull();
    expect(line!.direction).toBe("up");
    expect(line!.severity).toBe("warning");
    expect(line!.text).toBe(
      "Tool-call errors up 3× vs yesterday (42 in the last 24h, 14 the day before; 6-day median 12).",
    );
  });

  it("a quiet yesterday alone cannot manufacture a spike: the median is a baseline too", () => {
    // Yesterday was a lull (5), but the week runs at 30: 40 is normal.
    expect(detectAnomaly(def("tool_call_errors"), windowsFrom([40, 5, 30, 31, 29, 30, 32], 6))).toBeNull();
  });

  it("stays silent under the noise floor", () => {
    expect(detectAnomaly(def("tool_call_errors"), windowsFrom([4, 1, 1, 1, 1, 1, 1], 6))).toBeNull();
  });

  it("from nothing, it says 'none the day before' rather than infinity", () => {
    const line = detectAnomaly(def("reports"), windowsFrom([4, 0, 0, 0, 0, 0, 0, 0], 7));
    expect(line!.text).toBe("Reports filed: 4 in the last 24h, none the day before (7-day median 0).");
    expect(line!.severity).toBe("warning");
    // Five times the floor from nothing is critical.
    expect(detectAnomaly(def("reports"), windowsFrom([15], 7))!.severity).toBe("critical");
  });

  it("a fault at 5× its baseline is critical", () => {
    expect(detectAnomaly(def("tool_call_errors"), windowsFrom([60, 10, 10, 10, 10, 10, 10], 6))!.severity).toBe("critical");
  });

  it("a fault metric falling is not news; a traffic metric collapsing is", () => {
    expect(detectAnomaly(def("tool_call_errors"), windowsFrom([0, 50, 50, 50, 50, 50, 50], 6))).toBeNull();
    const down = detectAnomaly(def("agent_phases"), windowsFrom([20, 100, 90, 110, 100, 95, 105, 100], 7));
    expect(down!.direction).toBe("down");
    expect(down!.text).toBe(
      "Agent pulse phase changes down 80% vs yesterday (20 in the last 24h, 100 the day before; 7-day median 100).",
    );
    const stopped = detectAnomaly(def("speech"), windowsFrom([0, 40, 40, 40, 40, 40, 40, 40], 7));
    expect(stopped!.severity).toBe("critical");
    expect(stopped!.text).toBe("Lines spoken stopped: none in the last 24h (40 the day before; 7-day median 40).");
  });

  it("a collapse from a tiny baseline is not flagged", () => {
    expect(detectAnomaly(def("speech"), windowsFrom([0, 5, 5, 5, 5, 5, 5, 5], 7))).toBeNull();
  });

  it("spend is phrased in dollars", () => {
    const line = detectAnomaly(def("spend"), windowsFrom([9_000_000, 2_000_000, 2_000_000, 2_000_000], 7));
    expect(line!.text).toBe("Reported spend up 4.5× vs yesterday ($9.00 in the last 24h, $2.00 the day before; 7-day median $0.00).");
  });

  it("rows fold into windows per metric and critical lines sort first", () => {
    const w = metricsFromRows([
      { metric: "reports", d: 0, n: "20" },
      { metric: "tool_call_errors", d: 0, n: 42 },
      { metric: "tool_call_errors", d: 1, n: 14 },
      { metric: "tool_call_errors", d: 2, n: 12 },
      { metric: "tool_call_errors", d: 9, n: 999 },
    ]);
    expect(Object.keys(w).sort()).toEqual(OPS_METRICS.map((m) => m.key).sort());
    expect(w.tool_call_errors!.days).toEqual([42, 14, 12, 0, 0, 0, 0, 0]);
    const lines = anomaliesFor(w);
    expect(lines.map((l) => l.metric)).toEqual(["reports", "tool_call_errors"]);
  });

  it("every metric key is a plain identifier (it is spliced into the SQL)", () => {
    for (const m of OPS_METRICS) expect(m.key).toMatch(/^[a-z_]+$/);
    expect(opsMetricsSql().match(/UNION ALL/g)).toHaveLength(OPS_METRICS.length - 1);
  });
});

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("ops overview suite");

describe.skipIf(!hasDb)("ops overview against the database", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const actor = `agt_opstest_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the ops overview suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await pg?.query("DELETE FROM world_events WHERE actor_id = $1", [actor]);
    } finally {
      await redis?.quit();
      await pg?.end();
    }
  });

  it("buckets rows into trailing 24h windows in one statement", async () => {
    const before = await grove.ops.metrics();
    // Six faults in the last 24h, three 1.5 days ago, two 9 days ago (outside every window).
    const at = (hours: number, n: number) =>
      Array.from({ length: n }, () =>
        pg.query(
          `INSERT INTO world_events (type, actor_id, payload, created_at)
           VALUES ('agent_phase', $1, '{"verb":"error"}'::jsonb, now() - make_interval(hours => $2))`,
          [actor, hours],
        ),
      );
    await Promise.all([...at(2, 6), ...at(36, 3), ...at(24 * 9, 2)]);
    const after = await grove.ops.metrics();
    // Other suites write to the same ledger in parallel, so assert at least our rows.
    expect(after.agent_faults!.current - before.agent_faults!.current).toBeGreaterThanOrEqual(6);
    expect(after.agent_faults!.previous - before.agent_faults!.previous).toBeGreaterThanOrEqual(3);
    expect(after.agent_faults!.days).toHaveLength(8);
  });

  it("the overview carries every section, with schema names for the operator", async () => {
    const o = await grove.ops.overview();
    expect(o.health.postgres.ok).toBe(true);
    expect(o.health.redis.ok).toBe(true);
    expect("error" in o.schema).toBe(false);
    if (!("error" in o.schema)) {
      expect(Array.isArray(o.schema.pending)).toBe(true);
      expect(o.schema.onDisk).toBeGreaterThanOrEqual(30);
    }
    expect("error" in o.cost).toBe(false);
    if (!("error" in o.cost)) expect(o.cost.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(o.metrics)).toBe(true);
    expect(Array.isArray(o.anomalies)).toBe(true);
    expect("error" in o.email).toBe(false);
  });
});
