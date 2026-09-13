/**
 * Shared fixture tracking and teardown for every database-backed suite.
 *
 * WHY THIS EXISTS
 * Four separate agents each grew their own copy of "remember what I made, then
 * delete it in foreign-key order". They drifted: the api suite swept a dozen
 * tables with protected-id guards, the domain suites swept five and missed
 * orgs, speech and spaces entirely. This module is the one copy. Compose with
 * it — track what your test creates and call `cleanup()` — rather than adding
 * another table to another private `cleanupFixtures`.
 *
 * If your suite needs a table this does not sweep, add it to `cleanupSteps`
 * below, in foreign-key order, and every suite gains it at once.
 *
 * THE GUARANTEES, all of which pre-date this file and must survive it:
 *  - Foreign-key order: children first, `humans` last.
 *  - Protected ids: the canonical world and the canonical rooms ship with the
 *    migrations. Cleanup must never touch them, however a test tracked them.
 *  - All statements attempted: one bad row cannot strand the rest of the sweep.
 *  - Loud on failure: failures are aggregated and re-thrown, so a leak fails
 *    the suite instead of quietly accumulating rows in the test database.
 *  - Derive, don't trust: worlds, agents, orgs and rooms are re-queried by
 *    owner, catching rows a test forgot to register.
 */
import type { Pool } from "pg";
import type Redis from "ioredis";

// ---------------------------------------------------------------------------
// The *_test database guard.
//
// A bare "is DATABASE_URL set?" check is NOT enough: importing @grove/domain
// loads .env as a side effect, which populates DATABASE_URL from the deployed
// configuration before any test line is evaluated. Every database-backed suite
// therefore checks the database NAME, twice: once on process.env at module load
// (to decide whether to skip) and once on the url loadConfig() actually hands
// back (which can supply its own default).
// ---------------------------------------------------------------------------

export const TEST_DB_SUFFIX = "_test";

/** The database name inside a connection url, or null if it has none. */
export function databaseName(url: string): string | null {
  if (!url) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

export function isTestDatabase(url: string): boolean {
  const name = databaseName(url);
  return Boolean(name && name.endsWith(TEST_DB_SUFFIX));
}

/** True when the ambient DATABASE_URL names a throwaway database. `describe.skipIf(!hasTestDatabase())`. */
export function hasTestDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTestDatabase(env.DATABASE_URL ?? "");
}

/**
 * Throw unless this url names a *_test database.
 *
 * The message carries the database NAME only, never the url: it holds credentials.
 */
export function assertTestDatabase(url: string, what = "run this suite"): void {
  if (isTestDatabase(url)) return;
  throw new Error(
    `Refusing to ${what} against database "${databaseName(url) ?? "unknown"}": ` +
      `its name does not end in "${TEST_DB_SUFFIX}".`,
  );
}

/** The one-line skip notice, printed at module load when the url is wrong but present. */
export function warnIfNotTestDatabase(suite: string, env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL ?? "";
  if (!url || isTestDatabase(url)) return;
  // Name only, never the URL: it carries credentials.
  console.warn(
    `[grove] ${suite} SKIPPED: database "${databaseName(url) ?? "unknown"}" ` +
      `does not end in "${TEST_DB_SUFFIX}". Point DATABASE_URL at a throwaway test database.`,
  );
}

// ---------------------------------------------------------------------------
// Register-limiter IPs.
//
// The register limiter is 3/IP/hour and vitest runs files in PARALLEL. A shared
// IP makes the suite race itself. Every file that registers agents owns its own
// bucket; clearing it cannot then disturb a file running alongside.
//
// Keep these distinct. Add a line when a new file starts registering agents.
// ---------------------------------------------------------------------------

export const REGISTER_IPS = {
  spaceAccess: "10.99.0.1",
  pulseContext: "10.99.0.2",
  agentKeypair: "10.99.0.3",
  chronicle: "10.99.0.4",
  moderationQueue: "10.99.1.1",
  agentPhase: "10.99.5.1",
  speechWiring: "10.99.2.1",
  routesWiring: "10.99.2.2",
  agentAdapters: "10.99.3.1",
  civicRooms: "10.99.4.1",
  observeContext: "10.99.6.1",
  sayQuota: "10.99.6.2",
  eventProofs: "10.99.7.1",
  roomPolicy: "10.99.8.1",
} as const;

/** Clear a register bucket. Safe only because the caller owns the IP outright. */
export async function clearRegisterLimiter(redis: Redis, ip: string): Promise<void> {
  await redis.del(`ratelimit:ip:${ip}:register:hour`);
  await redis.del(`ratelimit:ip:${ip}:register:day`);
}

/** Clear the per-actor limiters so back-to-back fixtures don't trip them. */
export async function clearActorLimiters(redis: Redis, actorId: string): Promise<void> {
  for (const key of await redis.keys(`ratelimit:${actorId}:*`)) await redis.del(key);
}

// ---------------------------------------------------------------------------
// Protected rows.
// ---------------------------------------------------------------------------

/** Canonical rows that ship with the migrations. Cleanup must never touch them. */
export const PROTECTED_WORLD_IDS: ReadonlySet<string> = new Set(["aetheria-prime"]);
export const PROTECTED_ROOM_IDS: ReadonlySet<string> = new Set([
  "plaza",
  "library",
  "workshop",
  "stage",
  "garden",
  "board",
]);

// ---------------------------------------------------------------------------
// The tracker.
// ---------------------------------------------------------------------------

/** What the sweep needs. A GroveApp's `store` satisfies this structurally. */
export interface FixtureBackends {
  pg: Pool;
  redis?: Redis;
}

export interface FixtureIds {
  humanIds: Set<string>;
  worldIds: Set<string>;
  sessionIds: Set<string>;
  agentIds: Set<string>;
  orgIds: Set<string>;
}

export interface Fixtures {
  /** The raw sets, for the rare case that needs to inspect or seed them. */
  ids: FixtureIds;
  /** A human, plus the session cookie to evict from redis if one was issued. */
  trackHuman(id: string, cookie?: string): void;
  /** A world. Protected ids are ignored rather than tracked. */
  trackWorld(id: string): void;
  /**
   * Agents owned by a tracked human are swept via owner_human_id; an UNCLAIMED
   * agent has no owner, so it must be registered explicitly or it would leak.
   */
  trackAgent(id: string): void;
  /**
   * Orgs are owned by a human, so they are swept via owner_human_id too; this
   * is belt-and-braces for one created on a human a test forgot to register.
   */
  trackOrg(id: string): void;
  /** A session id on its own, when no Set-Cookie header passed through a test. */
  trackSession(sessionId: string): void;
  /** Delete everything tracked (and everything derived from it). Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * @param resolve backends, looked up lazily: most suites boot inside a test or a
 *   `beforeAll`, so there is nothing to talk to at the time this is called.
 *   Return `undefined`/`null` before boot and cleanup becomes a no-op.
 */
export function createFixtures(resolve: () => FixtureBackends | undefined | null): Fixtures {
  const ids: FixtureIds = {
    humanIds: new Set<string>(),
    worldIds: new Set<string>(),
    sessionIds: new Set<string>(),
    agentIds: new Set<string>(),
    orgIds: new Set<string>(),
  };

  function trackSession(sessionId: string) {
    ids.sessionIds.add(sessionId);
  }

  function trackHuman(id: string, cookie?: string) {
    ids.humanIds.add(id);
    const sid = /(?:^|;\s*)grove_session=([^;]+)/.exec(cookie ?? "")?.[1];
    if (sid) trackSession(decodeURIComponent(sid));
  }

  function trackWorld(id: string) {
    if (!PROTECTED_WORLD_IDS.has(id)) ids.worldIds.add(id);
  }

  function trackAgent(id: string) {
    ids.agentIds.add(id);
  }

  function trackOrg(id: string) {
    ids.orgIds.add(id);
  }

  async function cleanup(): Promise<void> {
    const humanIds = [...ids.humanIds];
    const sessionIds = [...ids.sessionIds];
    const trackedWorldIds = [...ids.worldIds];
    const trackedAgentIds = [...ids.agentIds];
    const trackedOrgIds = [...ids.orgIds];
    // Cleared before the first await: a second cleanup (afterEach then afterAll)
    // must not re-run the same sweep, and a throw below must not strand them.
    ids.humanIds.clear();
    ids.worldIds.clear();
    ids.sessionIds.clear();
    ids.agentIds.clear();
    ids.orgIds.clear();

    const backends = resolve();
    const pg = backends?.pg;
    if (
      !pg ||
      (!humanIds.length && !trackedWorldIds.length && !trackedAgentIds.length && !trackedOrgIds.length)
    ) {
      return;
    }

    // Derive rather than trust: anything these humans own, even if a test forgot
    // to register it.
    const ownedWorlds = await pg.query<{ id: string }>(
      `SELECT id FROM worlds WHERE owner_human_id = ANY($1::text[])`,
      [humanIds],
    );
    const worldIds = [...new Set([...trackedWorldIds, ...ownedWorlds.rows.map((r) => String(r.id))])].filter(
      (id) => !PROTECTED_WORLD_IDS.has(id),
    );
    const ownedAgents = await pg.query<{ id: string }>(
      `SELECT id FROM agents WHERE owner_human_id = ANY($1::text[])`,
      [humanIds],
    );
    const agentIds = [...new Set([...trackedAgentIds, ...ownedAgents.rows.map((r) => String(r.id))])];
    const ownedOrgs = await pg.query<{ id: string }>(
      `SELECT id FROM orgs WHERE owner_human_id = ANY($1::text[])`,
      [humanIds],
    );
    const orgIds = [...new Set([...trackedOrgIds, ...ownedOrgs.rows.map((r) => String(r.id))])];
    const actorIds = [...humanIds, ...agentIds];
    const campusRooms = await pg.query<{ id: string }>(
      `SELECT id FROM rooms WHERE world_id = ANY($1::text[]) OR owner_human_id = ANY($2::text[])`,
      [worldIds, humanIds],
    );
    const roomIds = campusRooms.rows.map((r) => String(r.id)).filter((id) => !PROTECTED_ROOM_IDS.has(id));

    const failures: string[] = [];
    for (const [sql, params] of cleanupSteps({ humanIds, agentIds, actorIds, worldIds, roomIds, orgIds })) {
      try {
        await pg.query(sql, params);
      } catch (err) {
        failures.push(`${sql.split("\n")[0]} -> ${(err as Error).message}`);
      }
    }
    if (sessionIds.length && backends?.redis) {
      try {
        await backends.redis.del(...sessionIds.map((sid) => `session:${sid}`));
      } catch (err) {
        failures.push(`redis session cleanup -> ${(err as Error).message}`);
      }
    }
    if (failures.length) throw new Error(`fixture cleanup failed:\n${failures.join("\n")}`);
  }

  return { ids, trackHuman, trackWorld, trackAgent, trackOrg, trackSession, cleanup };
}

interface SweepScope {
  humanIds: string[];
  agentIds: string[];
  actorIds: string[];
  worldIds: string[];
  roomIds: string[];
  orgIds: string[];
}

/**
 * Ordered by foreign key: children first, humans last. Each statement is
 * attempted even if an earlier one fails, so one bad row cannot strand the
 * rest; failures are re-thrown at the end so a leak is loud, never silent.
 *
 * agent_keys, and anything else declared ON DELETE CASCADE, is deliberately
 * absent — the parent delete takes it.
 */
function cleanupSteps(s: SweepScope): Array<[string, unknown[]]> {
  const { humanIds, agentIds, actorIds, worldIds, roomIds, orgIds } = s;
  return [
    [`DELETE FROM speech_deliveries WHERE recipient_id = ANY($1::text[])
        OR speech_id IN (SELECT id FROM speech WHERE sender_id = ANY($1::text[]) OR room_id = ANY($2::text[]))`,
      [actorIds, roomIds]],
    [`DELETE FROM speech WHERE sender_id = ANY($1::text[]) OR target_id = ANY($1::text[]) OR room_id = ANY($2::text[])`,
      [actorIds, roomIds]],
    [`DELETE FROM presence WHERE actor_id = ANY($1::text[]) OR room_id = ANY($2::text[])`, [actorIds, roomIds]],
    [`DELETE FROM instructions WHERE owner_human_id = ANY($1::text[]) OR agent_id = ANY($2::text[])`,
      [humanIds, agentIds]],
    [`DELETE FROM blocks WHERE blocker_id = ANY($1::text[]) OR blocked_id = ANY($1::text[])`, [actorIds]],
    [`DELETE FROM mutes WHERE muter_id = ANY($1::text[]) OR muted_id = ANY($1::text[])`, [actorIds]],
    [`DELETE FROM reports WHERE reporter_id = ANY($1::text[]) OR target_id = ANY($1::text[])`, [actorIds]],
    [`DELETE FROM notices WHERE author_id = ANY($1::text[])`, [actorIds]],
    [`DELETE FROM world_events WHERE actor_id = ANY($1::text[])`, [actorIds]],
    [`UPDATE invite_codes SET redeemed_by = NULL, redeemed_at = NULL WHERE redeemed_by = ANY($1::text[])`, [humanIds]],
    [`DELETE FROM agents WHERE id = ANY($1::text[])`, [agentIds]],
    [`DELETE FROM stage_events WHERE world_id = ANY($1::text[]) OR room_id = ANY($2::text[])`, [worldIds, roomIds]],
    [`DELETE FROM rooms WHERE id = ANY($1::text[])`, [roomIds]],
    [`DELETE FROM webhooks WHERE owner_human_id = ANY($1::text[])`, [humanIds]],
    // Space access (007) and orgs (008). All of these hang off a world, a
    // human or an org, so they must go before those three are removed.
    [`DELETE FROM space_invite_redemptions WHERE human_id = ANY($1::text[])
        OR code IN (SELECT code FROM space_invites WHERE world_id = ANY($2::text[]) OR created_by = ANY($1::text[]))`,
      [humanIds, worldIds]],
    [`DELETE FROM space_invites WHERE world_id = ANY($1::text[]) OR created_by = ANY($2::text[])`,
      [worldIds, humanIds]],
    [`DELETE FROM space_join_requests WHERE world_id = ANY($1::text[]) OR human_id = ANY($2::text[]) OR decided_by = ANY($2::text[])`,
      [worldIds, humanIds]],
    [`DELETE FROM world_orgs WHERE world_id = ANY($1::text[]) OR org_id = ANY($2::text[])`, [worldIds, orgIds]],
    [`DELETE FROM org_members WHERE org_id = ANY($1::text[]) OR human_id = ANY($2::text[])`, [orgIds, humanIds]],
    [`DELETE FROM orgs WHERE id = ANY($1::text[])`, [orgIds]],
    [`DELETE FROM world_members WHERE human_id = ANY($1::text[]) OR world_id = ANY($2::text[])`, [humanIds, worldIds]],
    [`DELETE FROM worlds WHERE id = ANY($1::text[])`, [worldIds]],
    [`DELETE FROM humans WHERE id = ANY($1::text[])`, [humanIds]],
  ];
}
