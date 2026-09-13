/**
 * Agent trials on the Stage (migration 040). The properties that matter:
 *  - an answer is stored only as a salted hash, and no read returns the answer,
 *    the hash, the salt or anybody else's nonce;
 *  - submissions are verified deterministically (answer, tool_run proof +
 *    tagged tool calls), the first correct one finishes, and the order is the
 *    order of finishing;
 *  - at most 10 submissions per entry;
 *  - the `trial` mark reaches a finisher's public home plot once per trial,
 *    never a private one;
 *  - trial events are public commons events in the chronicle;
 *  - only operators post, only claimed agents enter, and a span can be tagged
 *    only with a trial its agent entered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { hashTrialAnswer, trialProofFor } from "../src/services/trials.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.trials;
const hasDb = hasTestDatabase();

describe("trial hashing", () => {
  it("salts the answer hash and derives a per-entrant proof", () => {
    expect(hashTrialAnswer("a", "forty two")).not.toBe(hashTrialAnswer("b", "forty two"));
    expect(hashTrialAnswer("a", "forty two")).toMatch(/^[0-9a-f]{64}$/);
    expect(trialProofFor("n1", "trl_X")).toMatch(/^[0-9a-f]{16}$/);
    expect(trialProofFor("n1", "trl_X")).not.toBe(trialProofFor("n2", "trl_X"));
  });
});

describe.skipIf(!hasDb)("agent trials on the Stage", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the trials suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newHuman(prefix: string, operator = false) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    if (operator) {
      await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [human.id]);
      return { ...human, role: "operator" as const };
    }
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, claim = true) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `trier${tag()}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    if (!claim) return reg.agent;
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    await clearActorLimiters(redis, agent.id);
    return agent;
  }

  const answerTrial = async (op: Awaited<ReturnType<typeof newHuman>>, answer = "The Lantern") =>
    grove.trials.create(op, {
      title: `Riddle ${tag()}`,
      prompt: "What is lit at dusk and carried by the concierge?",
      kind: "answer",
      answer,
      durationMinutes: 20,
    });

  it("stores only a salted hash, never returns it, and refuses non-operators with a 404", async () => {
    const op = await newHuman("trial-op", true);
    const stranger = await newHuman("trial-stranger");
    await expect(grove.trials.create(stranger, { title: "x", prompt: "y", kind: "answer", answer: "z" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });

    const secret = `Zebra Crossing ${tag()}`;
    const trial = await answerTrial(op, secret);
    expect(trial.status).toBe("open");

    const { rows } = await pg.query(`SELECT * FROM trials WHERE id = $1`, [trial.id]);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(secret);
    expect(stored.toLowerCase()).not.toContain(secret.toLowerCase());
    const hash = String(rows[0].answer_hash);
    const salt = String(rows[0].answer_salt);
    expect(hash).toBe(hashTrialAnswer(salt, secret.toLowerCase()));

    const owner = await newHuman("trial-owner");
    const agent = await newAgent(owner);
    await grove.trials.enter(agent, trial.id);
    const reads = JSON.stringify([
      trial,
      await grove.trials.get(trial.id, agent),
      await grove.trials.listForAgent(agent),
      await grove.trials.listForAgent(null),
      await grove.trials.stage(),
      await grove.trials.listForOperator(op),
      await grove.chronicle.read({ humanId: null, isOperator: false }, { types: ["trial.opened", "trial.entered"], limit: 50 }),
      await grove.chronicle.read({ humanId: op.id, isOperator: true }, { types: ["trial.opened", "trial.entered"], limit: 50 }),
    ]).toLowerCase();
    for (const leak of [secret.toLowerCase(), hash, salt]) expect(reads).not.toContain(leak);
    await grove.trials.closeNow(op, trial.id);
  });

  it("verifies answers, finishes on the first correct one, and orders finishers by time", async () => {
    const op = await newHuman("trial-op2", true);
    const owner = await newHuman("trial-owner2");
    const a = await newAgent(owner);
    const b = await newAgent(owner);
    const pending = await newAgent(owner, false);
    const trial = await answerTrial(op, "  forty TWO ");

    await expect(grove.trials.submit(a, trial.id, { answer: "42" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grove.trials.enter(pending, trial.id)).rejects.toMatchObject({ code: "UNCLAIMED" });

    const entered = await grove.trials.enter(a, trial.id);
    expect(entered.entry.nonce).toBeNull();
    // Entering twice is the same entry.
    await grove.trials.enter(a, trial.id);
    await grove.trials.enter(b, trial.id);

    const wrong = await grove.trials.submit(a, trial.id, { answer: "42" });
    expect(wrong).toMatchObject({ correct: false, reason: "Not the answer." });
    expect(wrong.entry.submissionsLeft).toBe(9);

    const bRight = await grove.trials.submit(b, trial.id, { answer: "Forty two" });
    expect(bRight.correct).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const aRight = await grove.trials.submit(a, trial.id, { answer: "FORTY   two" });
    expect(aRight.correct).toBe(true);
    expect(aRight.entry.outcome).toBe("correct");
    await expect(grove.trials.submit(a, trial.id, { answer: "forty two" })).rejects.toMatchObject({ code: "CONFLICT" });

    const view = (await grove.trials.get(trial.id, null))!;
    const finished = view.entrants.filter((e) => e.finished).sort((x, y) => Date.parse(x.finishedAt!) - Date.parse(y.finishedAt!));
    expect(finished.map((e) => e.agentId)).toEqual([b.id, a.id]);
    // A's two submissions are two ticks; nothing says one was wrong.
    expect(view.entrants.find((e) => e.agentId === a.id)!.ticks).toBe(2);
    expect(JSON.stringify(view)).not.toMatch(/submissions|outcome|spent/);

    // Trial events are public commons events: a signed-out reader sees them, and can react.
    const anon = await grove.chronicle.read(
      { humanId: null, isOperator: false },
      { types: ["trial.opened", "trial.entered", "trial.finished"], limit: 200 },
    );
    const mine = anon.entries.filter((e) => (e.detail as { trialId?: string }).trialId === trial.id);
    expect(mine.map((e) => e.type).sort()).toEqual(["trial.entered", "trial.entered", "trial.finished", "trial.finished", "trial.opened"]);
    expect(mine.every((e) => e.kind === "trial" && e.reactionTarget?.kind === "event")).toBe(true);
    expect(mine.find((e) => e.type === "trial.finished" && e.actor?.id === b.id)!.summary).toContain("finished the trial");

    await grove.trials.closeNow(op, trial.id);
    await expect(grove.trials.submit(b, trial.id, { answer: "x" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(grove.trials.enter(b, trial.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const closedRows = await grove.chronicle.read({ humanId: null, isOperator: false }, { types: ["trial.closed"], limit: 50 });
    expect(closedRows.entries.filter((e) => (e.detail as { trialId?: string }).trialId === trial.id)).toHaveLength(1);
  });

  it("caps submissions at 10 per entry", async () => {
    const op = await newHuman("trial-op3", true);
    const owner = await newHuman("trial-owner3");
    const agent = await newAgent(owner);
    const trial = await answerTrial(op, "right");
    await grove.trials.enter(agent, trial.id);
    for (let i = 0; i < 10; i++) {
      const r = await grove.trials.submit(agent, trial.id, { answer: `wrong ${i}` });
      expect(r.correct).toBe(false);
    }
    const again = grove.trials.submit(agent, trial.id, { answer: "right" });
    await expect(again).rejects.toMatchObject({ code: expect.stringMatching(/RATE_LIMITED|CONFLICT/) });
    const entry = (await grove.trials.get(trial.id, agent)).entry!;
    expect(entry.submissionsLeft).toBe(0);
    expect(entry.outcome).toBe("spent");
    // Even with the limiter cleared, the row's own count holds.
    await clearActorLimiters(redis, agent.id);
    await expect(grove.trials.submit(agent, trial.id, { answer: "right" })).rejects.toMatchObject({ code: "CONFLICT" });
    await grove.trials.closeNow(op, trial.id);
  });

  it("checks a tool_run: tagged spans from an entrant only, then the entrant's own proof", async () => {
    const op = await newHuman("trial-op4", true);
    const owner = await newHuman("trial-owner4");
    const agent = await newAgent(owner);
    const other = await newAgent(owner);
    for (const x of [agent, other]) {
      await grove.presence.enter({ id: x.id, kind: "agent", ownerHumanId: owner.id }, "plaza", {
        connection: "async",
        mode: "autonomous",
        activity: "idle",
        overflowPlaza: true,
      });
    }
    const trial = await grove.trials.create(op, {
      title: `Run ${tag()}`,
      prompt: "Hash your nonce with a tool.",
      kind: "tool_run",
      minToolCalls: 2,
      durationMinutes: 10,
    });
    // Not entered: the tag is refused, and nothing is recorded.
    await expect(grove.toolCalls.start(agent.id, { name: "Bash", trialId: trial.id })).rejects.toMatchObject({ code: "INVALID" });

    const { entry } = await grove.trials.enter(agent, trial.id);
    const { entry: otherEntry } = await grove.trials.enter(other, trial.id);
    expect(entry.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(entry.proofRule).toContain("SHA-256");
    expect(otherEntry.nonce).not.toBe(entry.nonce);
    // Nobody else's nonce is in any public read.
    expect(JSON.stringify(await grove.trials.get(trial.id, other))).not.toContain(entry.nonce!);
    expect(JSON.stringify(await grove.trials.stage())).not.toContain(entry.nonce!);

    const proof = trialProofFor(entry.nonce!, trial.id);
    const early = await grove.trials.submit(agent, trial.id, { proof });
    expect(early.correct).toBe(false);
    expect(early.reason).toContain("at least 2 tool calls");

    for (let i = 0; i < 2; i++) {
      const span = await grove.toolCalls.start(agent.id, { name: "Bash", args: "shasum", trialId: trial.id });
      await grove.toolCalls.finish(agent.id, span.callId, { outcome: "ok" });
    }
    expect((await grove.trials.get(trial.id, agent)).entry!.taggedToolCalls).toBe(2);
    // Another entrant's proof does not count for you.
    expect((await grove.trials.submit(agent, trial.id, { proof: trialProofFor(otherEntry.nonce!, trial.id) })).correct).toBe(false);
    const done = await grove.trials.submit(agent, trial.id, { proof: proof.toUpperCase() });
    expect(done.correct).toBe(true);
    // A finished entrant can no longer tag.
    await expect(grove.toolCalls.start(agent.id, { name: "Bash", trialId: trial.id })).rejects.toMatchObject({ code: "INVALID" });
    const ticks = (await grove.trials.get(trial.id, null)).entrants.find((e) => e.agentId === agent.id)!.ticks;
    expect(ticks).toBe(5); // two tagged calls + three submissions
    await grove.trials.closeNow(op, trial.id);
  });

  it("marks a finisher's public home plot once per trial, and never a private one", async () => {
    const op = await newHuman("trial-op5", true);
    const openOwner = await newHuman("trial-plot");
    const privateOwner = await newHuman("trial-held");
    const t = tag();
    const openSpace = await grove.campus.createWorld(openOwner, { name: `Trial Yard ${t}`, slug: `trialyard-${t}`, preset: "public_view" });
    const heldSpace = await grove.campus.createWorld(privateOwner, { name: `Trial Keep ${t}`, slug: `trialkeep-${t}`, preset: "private" });
    fixtures.trackWorld(openSpace.id);
    fixtures.trackWorld(heldSpace.id);
    const winner = await newAgent(openOwner);
    await grove.identity.patchAgent(winner.id, openOwner, { homeRoomId: `${openSpace.id}:plaza` });
    const hidden = await newAgent(privateOwner);
    await grove.identity.patchAgent(hidden.id, privateOwner, { homeRoomId: `${heldSpace.id}:plaza` });

    const trial = await answerTrial(op, "moss");
    for (const x of [winner, hidden]) {
      await grove.trials.enter(x, trial.id);
      expect((await grove.trials.submit(x, trial.id, { answer: "Moss" })).correct).toBe(true);
    }
    const marks = async (worldId: string) =>
      (await pg.query(`SELECT mark FROM space_marks WHERE world_id = $1 AND mark = 'trial'`, [worldId])).rowCount;
    // Nothing until it closes.
    expect(await marks(openSpace.id)).toBe(0);
    await grove.trials.closeNow(op, trial.id);
    expect(await marks(openSpace.id)).toBe(1);
    expect(await marks(heldSpace.id)).toBe(0);
    // Once per trial: the claim is spent, a second award and a second advance do nothing.
    expect(await grove.trials.awardMarks(trial.id)).toBe(0);
    await grove.trials.advance();
    expect(await marks(openSpace.id)).toBe(1);
    expect((await grove.world.minimap()).spaces.find((s) => s.id === openSpace.id)?.marks).toContain("trial");
    expect((await grove.world.minimap()).spaces.find((s) => s.id === heldSpace.id)?.marks).toEqual([]);
  });

  it("opens a scheduled trial on its clock, announcing each edge exactly once", async () => {
    const op = await newHuman("trial-op6", true);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const trial = await grove.trials.create(op, { title: `Later ${tag()}`, prompt: "Soon.", kind: "answer", answer: "x", opensAt: soon, durationMinutes: 5 });
    expect(trial.status).toBe("scheduled");
    expect(trial.openedEventId).toBeNull();
    const opened = await grove.trials.openNow(op, trial.id);
    expect(opened.status).toBe("open");
    await Promise.all([grove.trials.advance(), grove.trials.advance(), grove.trials.advance()]);
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM world_events WHERE type = 'trial.opened' AND payload->>'trialId' = $1`, [trial.id]);
    expect(rows[0].n).toBe(1);
    await grove.trials.closeNow(op, trial.id);
    await Promise.all([grove.trials.advance(), grove.trials.advance()]);
    const { rows: closed } = await pg.query(`SELECT count(*)::int AS n FROM world_events WHERE type = 'trial.closed' AND payload->>'trialId' = $1`, [trial.id]);
    expect(closed[0].n).toBe(1);
  });
});
