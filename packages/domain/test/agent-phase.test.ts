import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import type { ChronicleViewer } from "../src/services/chronicle.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.agentPhase;

const hasDb = hasTestDatabase();

/**
 * Verb history (migration 017).
 *
 * `presence` is overwritten in place by every pulse, so until now an agent's
 * past did not exist anywhere. 017 gives it one: a trigger closes each stretch
 * of a verb into a `world_events` row, and the chronicle gates those rows to
 * the agent's owner and to operators.
 *
 * Two things are worth proving and they are different in kind:
 *
 *   * THE ARITHMETIC — that a stretch is a stretch, that a dead runtime is not
 *     recorded as having worked until eviction noticed, and that a two-second
 *     fault is never optimised away by the noise floor. Most of these need
 *     control of the clock, which PresenceService.pulse does not offer (it
 *     stamps now() and is capped at one pulse a second), so they drive the
 *     trigger with the same UPDATE that pulse() issues. One test goes through
 *     the real service anyway, so a trigger detached from the real write path
 *     cannot pass.
 *
 *   * THE GATE — that a working day reaches its owner and an operator and
 *     absolutely nobody else. Like the chronicle suite, this pins the exact
 *     event id an action produced rather than counting rows, because other
 *     files are writing to the same table at the same time.
 */
describe.skipIf(!hasDb)("an agent's working day", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

  const ANON: ChronicleViewer = { humanId: null, isOperator: false };
  const asHuman = (id: string): ChronicleViewer => ({ humanId: id, isOperator: false });
  const asOperator = (id: string): ChronicleViewer => ({ humanId: id, isOperator: true });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newOperator(prefix: string) {
    const human = await newHuman(prefix);
    await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [human.id]);
    return human;
  }

  /** A claimed agent with a body in the plaza, ready to pulse. */
  async function newInhabitant(owner: { id: string }, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner as never);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "plaza", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      overflowPlaza: true,
    });
    return agent;
  }

  /**
   * One pulse, at a chosen moment. This is character-for-character the columns
   * PresenceService.pulse writes; only the clock is ours.
   */
  async function pulseAt(
    actorId: string,
    verb: string,
    detail: string | null,
    base: Date,
    offsetSeconds: number,
    errorText: string | null = null,
  ) {
    const at = new Date(base.getTime() + offsetSeconds * 1000);
    await pg.query(
      `UPDATE presence SET verb = $2, detail = $3, error_text = $4, pulsed_at = $5, last_seen_at = $5
       WHERE actor_id = $1`,
      [actorId, verb, detail, errorText, at.toISOString()],
    );
  }

  /** Every phase this agent has on the ledger, oldest first. */
  async function phasesOf(actorId: string) {
    const { rows } = await pg.query(
      `SELECT id, payload FROM world_events
        WHERE type = 'agent_phase' AND actor_id = $1 ORDER BY id`,
      [actorId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      ...(r.payload as Record<string, unknown>),
    })) as Array<Record<string, unknown> & { id: string }>;
  }

  /** Every event id a viewer can reach for one actor, over enough pages to be sure. */
  async function idsFor(viewer: ChronicleViewer, actorId: string): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const p = await grove.chronicle.read(viewer, { actorId, limit: 200, cursor });
      for (const e of p.entries) out.add(e.id);
      if (!p.nextCursor) return out;
      cursor = p.nextCursor;
    }
    throw new Error("chronicle pagination did not terminate");
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the agent-phase suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await redis.quit();
    await pg.end();
  });

  // -------------------------------------------------------------------------
  // The arithmetic.
  // -------------------------------------------------------------------------

  it("records a run of one verb as a single stretch, and folds a short step into the one that follows", async () => {
    const owner = await newHuman("phase-owner");
    const agent = await newInhabitant(owner, `steady${tag()}`);
    const base = new Date(Date.now() - 3600_000);

    // A ten-second think, then three minutes of tool with a pulse every 30s —
    // the rhythm PULSE.md actually asks for.
    await pulseAt(agent.id, "think", "planning the migration", base, 0);
    await pulseAt(agent.id, "tool", "pnpm test:safe", base, 10);
    await pulseAt(agent.id, "tool", "pnpm test:safe", base, 40);
    await pulseAt(agent.id, "tool", "pnpm test:safe", base, 70);
    // ...then it goes idle, which closes the tool stretch.
    await pulseAt(agent.id, "idle", "turn finished", base, 200);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    const [tool] = phases;
    expect(tool!.verb).toBe("tool");
    // Nine pulses would have been nine rows. Coalescing makes it one.
    expect(tool!.seconds).toBe(200);
    // The ten-second think was below the floor, so it has no row of its own —
    // but its time is not lost, it is carried into the stretch that followed.
    expect(Date.parse(String(tool!.started_at))).toBe(base.getTime());
    expect(tool!.detail).toBe("pnpm test:safe");
    expect(tool!.silent).toBeUndefined();
  });

  it("keeps a fault whole however brief it was", async () => {
    const owner = await newHuman("phase-fault");
    const agent = await newInhabitant(owner, `faulty${tag()}`);
    const base = new Date(Date.now() - 3600_000);

    await pulseAt(agent.id, "error", "worker crashed", base, 0, "TypeError: cannot read 'rows'");
    await pulseAt(agent.id, "think", "picking up the pieces", base, 20);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    // Twenty seconds is far below the 180s noise floor. A fault is exempt,
    // because "it faulted twice overnight" is the question this all exists for.
    expect(phases[0]!.verb).toBe("error");
    expect(phases[0]!.seconds).toBe(20);
    expect(phases[0]!.error_text).toBe("TypeError: cannot read 'rows'");
  });

  it("does not record a dead runtime as having worked until eviction noticed", async () => {
    const owner = await newHuman("phase-silent");
    const agent = await newInhabitant(owner, `silent${tag()}`);
    const base = new Date(Date.now() - 7200_000);

    await pulseAt(agent.id, "tool", "rebuilding the index", base, 0);
    await pulseAt(agent.id, "tool", "rebuilding the index", base, 30);
    // ...and then nothing for an hour, until something finally closed it.
    await pulseAt(agent.id, "idle", "back", base, 3600);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    // The stretch ends at the stall threshold, not at the hour mark: it claimed
    // `tool` for 30 seconds and was then silent, which is not an hour of work.
    expect(phases[0]!.seconds).toBe(30 + 180);
    expect(phases[0]!.silent).toBe(true);
  });

  it("treats idle as rest, never as a stall", async () => {
    const owner = await newHuman("phase-rest");
    const agent = await newInhabitant(owner, `resting${tag()}`);
    const base = new Date(Date.now() - 7200_000);

    await pulseAt(agent.id, "idle", "waiting for the next turn", base, 0);
    await pulseAt(agent.id, "think", "a request arrived", base, 3600);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    // A full hour of idle, uncut and unflagged. PULSE.md: an agent correctly
    // saying it is at rest is not a crashed one.
    expect(phases[0]!.verb).toBe("idle");
    expect(phases[0]!.seconds).toBe(3600);
    expect(phases[0]!.silent).toBeUndefined();
  });

  it("does not invent a stretch out of a heartbeat", async () => {
    const owner = await newHuman("phase-beat");
    const agent = await newInhabitant(owner, `beating${tag()}`);
    const base = new Date(Date.now() - 3600_000);

    await pulseAt(agent.id, "tool", "a long build", base, 0);
    const before = await phasesOf(agent.id);
    // A heartbeat, a seat change and a connection downgrade all UPDATE presence
    // without moving pulsed_at. None of them is an agent saying anything.
    for (let i = 0; i < 5; i++) {
      await pg.query("UPDATE presence SET last_seen_at = now(), connection = 'live' WHERE actor_id = $1", [
        agent.id,
      ]);
    }
    expect(await phasesOf(agent.id)).toEqual(before);
  });

  it("closes the open stretch when the body leaves", async () => {
    const owner = await newHuman("phase-leave");
    const agent = await newInhabitant(owner, `leaving${tag()}`);

    await pulseAt(agent.id, "blocked", "waiting on review", new Date(Date.now() - 600_000), 0);
    expect(await phasesOf(agent.id)).toHaveLength(0);

    await grove.presence.leave(agent.id);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.verb).toBe("blocked");
    // Nothing may outlive the presence row it described.
    const { rows } = await pg.query("SELECT 1 FROM agent_phase_open WHERE actor_id = $1", [agent.id]);
    expect(rows).toHaveLength(0);
  });

  it("is wired to the real pulse path, not only to a hand-written UPDATE", async () => {
    const owner = await newHuman("phase-real");
    const agent = await newInhabitant(owner, `real${tag()}`);

    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "worker crashed", { errorText: "boom" });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "think", "recovering");

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.verb).toBe("error");
    expect(phases[0]!.error_text).toBe("boom");
  });

  // -------------------------------------------------------------------------
  // The gate.
  // -------------------------------------------------------------------------

  it("shows a working day to its owner and to an operator, and to nobody else", async () => {
    const owner = await newHuman("phase-mine");
    const stranger = await newHuman("phase-stranger");
    const rival = await newHuman("phase-rival");
    const operator = await newOperator("phase-op");

    const agent = await newInhabitant(owner, `mine${tag()}`);
    // The rival owns an agent of their own, so this is owner-versus-owner and
    // not merely signed-in-versus-owner.
    await newInhabitant(rival, `theirs${tag()}`);

    const base = new Date(Date.now() - 3600_000);
    await pulseAt(agent.id, "blocked", "waiting on review", base, 0, "needs a human");
    await pulseAt(agent.id, "idle", "given up for now", base, 400);

    const phases = await phasesOf(agent.id);
    expect(phases).toHaveLength(1);
    const eventId = phases[0]!.id;

    expect(await idsFor(asHuman(owner.id), agent.id)).toContain(eventId);
    expect(await idsFor(asOperator(operator.id), agent.id)).toContain(eventId);

    // A caption is a work diary. The live map publishes one instant of it; a
    // retained series is nobody else's.
    expect(await idsFor(asHuman(stranger.id), agent.id)).not.toContain(eventId);
    expect(await idsFor(asHuman(rival.id), agent.id)).not.toContain(eventId);
    expect(await idsFor(ANON, agent.id)).not.toContain(eventId);
  });

  it("reads back as a sentence an owner can act on, not as a payload", async () => {
    const owner = await newHuman("phase-prose");
    const agent = await newInhabitant(owner, `prose${tag()}`);
    const base = new Date(Date.now() - 7200_000);

    await pulseAt(agent.id, "blocked", "waiting on review", base, 0, "needs a human");
    await pulseAt(agent.id, "idle", "gave up", base, 3600);

    const phases = await phasesOf(agent.id);
    const eventId = phases[0]!.id;
    const page = await grove.chronicle.read(asHuman(owner.id), { actorId: agent.id, limit: 200 });
    const entry = page.entries.find((e) => e.id === eventId);

    expect(entry).toBeTruthy();
    expect(entry!.kind).toBe("work");
    expect(entry!.moderation).toBe(false);
    // The server writes the prose; the browser only groups it.
    expect(entry!.summary).toContain("was blocked for");
    expect(entry!.summary).toContain("waiting on review");
    expect(entry!.summary).toContain("then went silent");
    // ...and the numbers come too, because a page that wants to total a day by
    // verb needs them and must not have to parse the sentence.
    expect(entry!.detail.verb).toBe("blocked");
    expect(entry!.detail.seconds).toBe(180);
    expect(entry!.detail.error_text).toBe("needs a human");
    // The allow-list is a list: a payload field nobody put on it stays private.
    expect(Object.keys(entry!.detail).sort()).toEqual(
      ["detail", "ended_at", "error_text", "seconds", "silent", "started_at", "verb"],
    );
  });

  it("offers `work` as a filter that finds phases and nothing else", async () => {
    const owner = await newHuman("phase-filter");
    const agent = await newInhabitant(owner, `filter${tag()}`);
    const base = new Date(Date.now() - 3600_000);

    await pulseAt(agent.id, "read", "reading migrations", base, 0);
    await pulseAt(agent.id, "idle", "done", base, 400);

    const page = await grove.chronicle.read(asHuman(owner.id), {
      actorId: agent.id,
      kinds: ["work"],
      limit: 200,
    });
    expect(page.entries.length).toBeGreaterThan(0);
    for (const e of page.entries) expect(e.type).toBe("agent_phase");
    // The agent walked into the plaza to get a body; that is not work.
    expect(page.totals.byType.actor_joined_room).toBeUndefined();
  });
});
