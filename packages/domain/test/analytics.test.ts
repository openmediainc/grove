/**
 * First-party analytics (migration 033): counts, never people.
 *
 * The properties that matter: DNT/GPC and bots are refused; a unique visitor is
 * a truncated HMAC under a salt that only lives for its day; nothing written
 * holds an IP, user agent or id; the cohort grid is numbers; and the prune
 * removes counters past 90 days plus every salt and bucket whose period ended.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  ANALYTICS_BUCKET_HEX,
  ANALYTICS_RETENTION_DAYS,
  bucketOf,
  cohortsFromRows,
  looksLikeBot,
  seriesFromRows,
  trackingRefused,
  utcDayOf,
  utcWeekOf,
  weeksBetween,
} from "../src/services/analytics.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

describe("analytics helpers", () => {
  it("DNT and GPC refuse; anything else does not", () => {
    expect(trackingRefused({ dnt: "1" })).toBe(true);
    expect(trackingRefused({ "sec-gpc": "1" })).toBe(true);
    expect(trackingRefused({ dnt: "0" })).toBe(false);
    expect(trackingRefused({})).toBe(false);
  });

  it("a simple bot check", () => {
    expect(looksLikeBot(CHROME)).toBe(false);
    expect(looksLikeBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(looksLikeBot("curl/8.4.0")).toBe(true);
    expect(looksLikeBot("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0")).toBe(true);
    expect(looksLikeBot("")).toBe(true);
    expect(looksLikeBot(undefined)).toBe(true);
  });

  it("buckets are short, salt-dependent and carry nothing readable", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const x = bucketOf(a, "203.0.113.9", CHROME);
    expect(x).toMatch(new RegExp(`^[0-9a-f]{${ANALYTICS_BUCKET_HEX}}$`));
    expect(bucketOf(a, "203.0.113.9", CHROME)).toBe(x);
    expect(bucketOf(b, "203.0.113.9", CHROME)).not.toBe(x);
    expect(x).not.toContain("203");
  });

  it("UTC day and Monday-start week", () => {
    const sun = Date.UTC(2026, 8, 13, 23, 59); // Sunday 13 Sep 2026
    expect(utcDayOf(sun)).toBe("2026-09-13");
    expect(utcWeekOf(sun)).toBe("2026-09-07");
    expect(utcWeekOf(Date.UTC(2026, 8, 14, 0, 1))).toBe("2026-09-14");
    expect(weeksBetween("2026-08-31", "2026-09-14")).toBe(2);
  });

  it("series: today, yesterday and the median of the seven days before", () => {
    const rows = [
      { day: "2026-09-13", event: "visit", n: "40" },
      { day: "2026-09-12", event: "visit", n: 10 },
      { day: "2026-09-11", event: "visit", n: 12 },
      { day: "2026-09-10", event: "visit", n: 8 },
      { day: "2026-09-01", event: "visit", n: 999 }, // outside the window
    ];
    const s = seriesFromRows(rows, "2026-09-13");
    const visit = s.find((x) => x.key === "visit")!;
    expect(visit).toMatchObject({ today: 40, yesterday: 10, days: [40, 10, 12, 8, 0, 0, 0, 0] });
    expect(visit.median7).toBe(0); // [10,12,8,0,0,0,0]
    expect(s.find((x) => x.key === "sign_in")).toMatchObject({ today: 0, yesterday: 0, median7: 0 });
    expect(s.map((x) => x.key)).toEqual(["visit", "unique_visitor", "sign_in", "walk_in", "follow", "message", "reaction"]);
  });

  it("cohorts: newest first, only weeks that have begun, sizes from the humans count", () => {
    const c = cohortsFromRows(
      [{ week: "2026-08-31", n: "4" }],
      [
        { cohort_week: "2026-08-31", active_week: "2026-08-31", n: "4" },
        { cohort_week: "2026-08-31", active_week: "2026-09-14", n: "1" },
      ],
      "2026-09-14",
      3,
    );
    expect(c).toEqual([
      { cohortWeek: "2026-09-14", size: 0, active: [0] },
      { cohortWeek: "2026-09-07", size: 0, active: [0, 0] },
      { cohortWeek: "2026-08-31", size: 4, active: [4, 0, 1] },
    ]);
  });
});

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("analytics store", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  // A day nobody else writes: real traffic in the test DB cannot move these counts.
  const PAST = Date.UTC(2001, 0, 10, 12);
  const PAST_DAY = utcDayOf(PAST);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the analytics suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    await pg.query(`DELETE FROM analytics_daily WHERE day < '2002-01-01'`);
    await pg.query(`DELETE FROM analytics_buckets WHERE period < '2002-01-01'`);
    await pg.query(`DELETE FROM analytics_salts WHERE period < '2002-01-01'`);
  });

  afterAll(async () => {
    try {
      await pg.query(`DELETE FROM analytics_daily WHERE day < '2002-01-01'`);
      await pg.query(`DELETE FROM analytics_buckets WHERE period < '2002-01-01'`);
      await pg.query(`DELETE FROM analytics_salts WHERE period < '2002-01-01'`);
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  const count = async (day: string, event: string) =>
    Number((await pg.query(`SELECT n FROM analytics_daily WHERE day = $1::date AND event = $2`, [day, event])).rows[0]?.n ?? 0);

  it("page views count every time, unique visitors once per bucket per day", async () => {
    await grove.analytics.visit({ ip: "198.51.100.7", userAgent: CHROME, now: PAST });
    await grove.analytics.visit({ ip: "198.51.100.7", userAgent: CHROME, now: PAST + 1000 });
    await grove.analytics.visit({ ip: "198.51.100.8", userAgent: CHROME, now: PAST + 2000 });
    expect(await count(PAST_DAY, "visit")).toBe(3);
    expect(await count(PAST_DAY, "unique_visitor")).toBe(2);

    // Nothing written anywhere holds the address or the user agent.
    const dump = JSON.stringify([
      (await pg.query(`SELECT * FROM analytics_daily WHERE day = $1::date`, [PAST_DAY])).rows,
      (await pg.query(`SELECT scope, period, bucket FROM analytics_buckets WHERE period = $1::date`, [PAST_DAY])).rows,
    ]);
    expect(dump).not.toContain("198.51.100");
    expect(dump).not.toContain("Chrome");
    const buckets = (await pg.query(`SELECT bucket FROM analytics_buckets WHERE period = $1::date`, [PAST_DAY])).rows;
    expect(buckets).toHaveLength(2);
    for (const b of buckets) expect(b.bucket).toHaveLength(ANALYTICS_BUCKET_HEX);
  });

  it("the next day has a new salt, so the same visitor is a new unique and the days cannot be joined", async () => {
    const next = PAST + 86_400_000;
    await grove.analytics.visit({ ip: "198.51.100.7", userAgent: CHROME, now: next });
    expect(await count(utcDayOf(next), "unique_visitor")).toBe(1);
    const { rows } = await pg.query(
      `SELECT to_char(period, 'YYYY-MM-DD') AS period, bucket FROM analytics_buckets WHERE scope = 'visitor' AND period IN ($1::date, $2::date)`,
      [PAST_DAY, utcDayOf(next)],
    );
    const day1 = rows.filter((r) => r.period === PAST_DAY).map((r) => r.bucket);
    const day2 = rows.filter((r) => r.period === utcDayOf(next)).map((r) => r.bucket);
    const salts = await pg.query(`SELECT salt FROM analytics_salts WHERE scope = 'visitor' AND period IN ($1::date, $2::date)`, [
      PAST_DAY,
      utcDayOf(next),
    ]);
    expect(salts.rows).toHaveLength(2);
    expect(Buffer.compare(salts.rows[0].salt, salts.rows[1].salt)).not.toBe(0);
    // Same person, different bucket (overwhelmingly likely at 24 bits).
    expect(day1).not.toContain(day2[0]);
  });

  it("actions bump their day's counter", async () => {
    await grove.analytics.record("sign_in", { now: PAST });
    await grove.analytics.record("walk_in", { now: PAST });
    await grove.analytics.record("walk_in", { now: PAST });
    expect(await count(PAST_DAY, "sign_in")).toBe(1);
    expect(await count(PAST_DAY, "walk_in")).toBe(2);
    const s = await grove.analytics.summary(PAST);
    expect(s.series.find((x) => x.key === "walk_in")).toMatchObject({ today: 2 });
    expect(s.retentionDays).toBe(ANALYTICS_RETENTION_DAYS);
  });

  it("a person is active once per week, in the cell for the week they first signed in", async () => {
    const email = `analytics-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);

    expect(await grove.analytics.markActive(human.id)).toBe(true);
    expect(await grove.analytics.markActive(human.id)).toBe(false);
    // Before they existed: never a cell.
    expect(await grove.analytics.markActive(human.id, PAST)).toBe(false);
    expect(await grove.analytics.markActive("hum_does_not_exist")).toBe(false);

    const s = await grove.analytics.summary();
    const mine = s.cohorts.find((c) => c.cohortWeek === utcWeekOf(Date.now()))!;
    expect(mine.size).toBeGreaterThanOrEqual(1);
    expect(mine.active[0]).toBeGreaterThanOrEqual(1);
    const marks = await pg.query(`SELECT bucket FROM analytics_buckets WHERE scope = 'active' AND period = $1::date`, [
      utcWeekOf(Date.now()),
    ]);
    expect(JSON.stringify(marks.rows)).not.toContain(human.id);
  });

  it("prune drops counters past 90 days and every salt and bucket whose period is over", async () => {
    const old = PAST - (ANALYTICS_RETENTION_DAYS + 5) * 86_400_000;
    await grove.analytics.record("follow", { now: old });
    expect(await count(utcDayOf(old), "follow")).toBe(1);

    const result = await grove.analytics.prune(PAST);
    expect(result.daily).toBeGreaterThanOrEqual(1);
    expect(await count(utcDayOf(old), "follow")).toBe(0);
    expect(await count(PAST_DAY, "visit")).toBe(3); // inside retention: kept

    // PAST's own salt and buckets are today's as far as this prune knows: kept.
    const kept = await pg.query(`SELECT 1 FROM analytics_salts WHERE scope = 'visitor' AND period = $1::date`, [PAST_DAY]);
    expect(kept.rowCount).toBe(1);

    // A day later, PAST's salt and buckets are gone; its counts stay.
    await grove.analytics.prune(PAST + 86_400_000);
    const gone = await pg.query(`SELECT 1 FROM analytics_salts WHERE scope = 'visitor' AND period = $1::date`, [PAST_DAY]);
    expect(gone.rowCount).toBe(0);
    const goneBuckets = await pg.query(`SELECT 1 FROM analytics_buckets WHERE scope = 'visitor' AND period = $1::date`, [PAST_DAY]);
    expect(goneBuckets.rowCount).toBe(0);
    expect(await count(PAST_DAY, "unique_visitor")).toBe(2);
  });
});
