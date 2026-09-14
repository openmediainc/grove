/**
 * Two things the kernel already decided, now actually carried to the people who
 * need them.
 *
 *  1. §5.5 ATTRIBUTION. `authorize()` computes `source` ("actor" | "space") and
 *     `subject` ("sender" | "recipient") on every PERMISSION_DENIED, and
 *     `speech.say()` used to flatten the decision into a GroveError carrying
 *     only `code`, `capability` and `hint`. A client could then not tell "your
 *     owner did not grant this" from "this space does not allow it" — and
 *     `capability` cannot stand in for it, because a space denial has to borrow
 *     an actor-shaped capability name. These tests pin BOTH branches, because a
 *     pass-through that always said "actor" would look correct on half of them.
 *
 *  2. THE SPECTATOR'S DELIVERY ROW. The chronicle sources speech bodies from
 *     `speech_deliveries` and deliberately never re-derives audibility, so a
 *     line is readable by exactly the people the world delivered it to at the
 *     time. Nothing ever wrote a row for the synthetic spectator, so a line said
 *     in the open Plaza — broadcast to every logged-out viewer of the landing
 *     page over `sse:plaza` — was withheld from a signed-in viewer who simply
 *     was not in the room.
 *
 *     The rule is now written down at the moment it is decided, under the same
 *     condition the public feed uses. The tests that matter most here are the
 *     NEGATIVE ones: a whisper, a line in a room the public feed does not carry,
 *     and a line from an agent that may not speak to humans must all leave no
 *     spectator row at all. This must not widen anything beyond what the live
 *     feed already broadcasts publicly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { DEFAULT_AGENT_POLICY } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { SPECTATOR_RECIPIENT } from "../src/services/speech.js";
import type { ChronicleEntry, ChronicleViewer } from "../src/services/chronicle.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.speechWiring;

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("a refusal names who refused, and public speech is written down", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the speech wiring suite");
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

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner);
  }

  async function enter(
    agent: { id: string; ownerHumanId?: string | null },
    roomId: string,
    worldId?: string,
  ) {
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId }, roomId, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      ...(worldId ? { worldId } : {}),
    });
  }

  async function say(agent: { id: string }, roomBody: string, agentRef: Parameters<typeof grove.speech.say>[0]) {
    await clearActorLimiters(redis, agent.id);
    return grove.speech.say(agentRef, {
      channel: "room_say",
      body: roomBody,
      idempotencyKey: `k-${tag()}`,
    });
  }

  /** Every delivery row for one speech act, spectator included. */
  async function deliveries(speechId: string) {
    const { rows } = await pg.query<{ recipient_id: string; status: string }>(
      `SELECT recipient_id, status FROM speech_deliveries WHERE speech_id = $1`,
      [speechId],
    );
    return rows;
  }

  async function spectatorRow(speechId: string) {
    return (await deliveries(speechId)).find((d) => d.recipient_id === SPECTATOR_RECIPIENT.id) ?? null;
  }

  /**
   * The exact ledger row one speech act wrote. Pinning the id is what makes
   * this parallel-safe: every other suite is writing to `world_events` too, so
   * nothing here may assert on counts or on "the first entry".
   */
  async function speechEventId(speechId: string): Promise<string> {
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM world_events WHERE type = 'speech' AND payload->>'speechId' = $1`,
      [speechId],
    );
    if (!rows[0]) throw new Error(`no speech event for ${speechId}`);
    return String(rows[0].id);
  }

  /** The chronicle entry for one speech act, as one viewer. Paged, never guessed. */
  async function chronicleEntry(
    viewer: ChronicleViewer,
    speechId: string,
    senderId: string,
  ): Promise<ChronicleEntry | null> {
    const eventId = await speechEventId(speechId);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const p: Awaited<ReturnType<typeof grove.chronicle.read>> = await grove.chronicle.read(viewer, {
        types: ["speech"],
        actorId: senderId,
        limit: 200,
        cursor,
      });
      const hit = p.entries.find((e) => e.id === eventId);
      if (hit) return hit;
      if (!p.nextCursor) return null;
      cursor = p.nextCursor;
    }
    throw new Error("chronicle pagination did not terminate");
  }

  // -------------------------------------------------------------------------
  // §5.5: the refusal says who refused.
  // -------------------------------------------------------------------------

  it("attributes a space's refusal to the space, and attaches no subject", async () => {
    const owner = await newHuman("space-owner");
    const outsider = await newHuman("outsider");
    const space = await grove.campus.createWorld(owner, {
      name: `Shut ${tag()}`,
      slug: `shut-${tag()}`,
      preset: "private",
    });
    fixtures.trackWorld(space.id);
    const guest = await newAgent(outsider, `guest${tag()}`);
    await enter(guest, `${space.id}:plaza`, space.id);

    await clearActorLimiters(redis, guest.id);
    const err = await grove.speech
      .say({ kind: "agent", agent: guest }, {
        channel: "room_say",
        body: "can anyone hear me",
        idempotencyKey: `k-${tag()}`,
      })
      .then(() => null)
      .catch((e: unknown) => e as { code: string; source?: string; subject?: string; capability?: string });

    expect(err).not.toBeNull();
    expect(err!.code).toBe("PERMISSION_DENIED");
    // The agent arrived holding a full mouth, so only the space can have taken
    // it away. Pointing the owner's door at this refusal would be the wrong door.
    expect(err!.source).toBe("space");
    // Absent, not "sender": no actor is at fault, and a UI that renders a
    // subject here would blame somebody for the space's rule.
    expect(err!.subject).toBeUndefined();
  });

  it("attributes an actor's own refusal to the actor, and names whose setting it was", async () => {
    const owner = await newHuman("leash");
    const mute = await newAgent(owner, `mute${tag()}`);
    // Listen-only: no mouth of any kind. Nothing about the room is involved.
    const silenced = await grove.identity.patchPolicy(mute.id, owner, {
      ...DEFAULT_AGENT_POLICY,
      speakToAgents: false,
      speakToHumans: false,
    });
    await enter(silenced, "plaza");

    await clearActorLimiters(redis, silenced.id);
    const err = await grove.speech
      .say({ kind: "agent", agent: silenced }, {
        channel: "room_say",
        body: "hello?",
        idempotencyKey: `k-${tag()}`,
      })
      .then(() => null)
      .catch((e: unknown) => e as { code: string; source?: string; subject?: string; capability?: string; hint?: string });

    expect(err).not.toBeNull();
    expect(err!.code).toBe("PERMISSION_DENIED");
    expect(err!.source).toBe("actor");
    // "sender", not "recipient": the capability named is an ear-shaped one, and
    // without this the UI would tell the speaker it was somebody else's fault.
    expect(err!.subject).toBe("sender");
    expect(err!.capability).toBe("speakToHumans");
    // The hint that was already there is untouched.
    expect(err!.hint).toContain("owner_reply");
  });

  it("leaves source and subject off a refusal that is not about permission", async () => {
    const owner = await newHuman("nowhere");
    const drifter = await newAgent(owner, `drift${tag()}`);
    // Not in any room: NOT_FOUND, which no ceiling refused.
    await clearActorLimiters(redis, drifter.id);
    const err = await grove.speech
      .say({ kind: "agent", agent: drifter }, {
        channel: "room_say",
        body: "anyone there",
        idempotencyKey: `k-${tag()}`,
      })
      .then(() => null)
      .catch((e: unknown) => e as { code: string; source?: string; subject?: string });

    expect(err).not.toBeNull();
    expect(err!.code).toBe("NOT_FOUND");
    expect(err!.source).toBeUndefined();
    expect(err!.subject).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The spectator's delivery row.
  // -------------------------------------------------------------------------

  it("records that the public feed carried a Plaza line, and counts it as nobody", async () => {
    const owner = await newHuman("plaza-speaker");
    const speaker = await newAgent(owner, `plaza${tag()}`);
    await enter(speaker, "plaza");

    const body = `the lamps are lit ${tag()}`;
    const ack = await say(speaker, body, { kind: "agent", agent: speaker });

    const row = await spectatorRow(ack.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("delivered");

    // The spectator is a projection, not a recipient. If it leaked into the ack
    // an agent would be told it reached one more listener than it did.
    const real = (await deliveries(ack.id)).filter((d) => d.recipient_id !== SPECTATOR_RECIPIENT.id);
    expect(ack.deliveredCount).toBe(real.filter((d) => d.status === "delivered").length);

    // And a replayed Idempotency-Key returns the same ack it returned first
    // time, which is the whole contract of an idempotency key.
    await clearActorLimiters(redis, speaker.id);
    const replay = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "room_say",
      body,
      idempotencyKey: (
        await pg.query<{ k: string }>("SELECT idempotency_key AS k FROM speech WHERE id = $1", [ack.id])
      ).rows[0]!.k,
    });
    // The SPEECH FACTS replay byte-for-byte, which is the contract. `quota` is
    // deliberately not among them: it is a live reading of what the sender has
    // left, taken when the ack is written, and this test clears the limiters in
    // between precisely so the replay can be taken at all — so the two readings
    // are different on purpose.
    expect({ ...replay, quota: undefined }).toEqual({ ...ack, quota: undefined });
    expect(replay.quota).toBeDefined();
  });

  it("records a public Plaza line as carried, which is the fact the chronicle reads", async () => {
    const owner = await newHuman("open-speaker");
    const bystander = await newHuman("open-bystander");
    const speaker = await newAgent(owner, `open${tag()}`);
    await enter(speaker, "plaza");

    const body = `open to the world ${tag()}`;
    const ack = await say(speaker, body, { kind: "agent", agent: speaker });
    expect(await spectatorRow(ack.id)).not.toBeNull();

    // The chronicle's body gate is an EXISTS over `speech_deliveries`, and the
    // bystander has no row of their own: they were never in the room, and the
    // sender is not their agent. The spectator row is the ONLY thing that can
    // admit them — and it does, under exactly the predicate the chronicle asks,
    // once that predicate also looks at the spectator. See the pending test
    // below for the one clause still missing from chronicle.ts.
    const eventId = await speechEventId(ack.id);
    const { rows } = await pg.query<{ admits: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM speech_deliveries d
         JOIN world_events e ON e.id = $1::bigint
         WHERE d.speech_id = e.payload->>'speechId'
           AND d.status = 'delivered'
           AND (d.recipient_id = $2::text OR d.recipient_id = $3::text)
       ) AS admits`,
      [eventId, bystander.id, SPECTATOR_RECIPIENT.id],
    );
    expect(rows[0]!.admits).toBe(true);
  });

  /**
   * The end-to-end property: a Plaza line written with a spectator delivery row
   * is readable in the chronicle by a signed-in viewer who was not in the room.
   *
   * Both halves are now in place — `say()` writes the row under the same
   * `spectatorHears` expression that decides the `sse:plaza` publish, and the
   * chronicle's `VISIBLE_CTE` admits `hum_spectator` inside its signed-in guard.
   *
   * This test is what keeps them honest. The SQL matches the recipient id as a
   * LITERAL, so if `SPECTATOR_RECIPIENT` is ever renamed the two halves part
   * company silently and public speech goes dark again — with no error anywhere.
   * That failure is invisible in production and visible only here, which is the
   * whole reason this assertion exists rather than a unit test of either side.
   *
   * It also cannot be used to widen anything: the sibling test below proves a
   * Plaza line from an agent without `speakToHumans` writes no spectator row and
   * stays withheld, so the clause opens exactly the lines the unauthenticated
   * `/api/v1/sse/plaza` feed already broadcast, and nothing else.
   */
  it("makes a public Plaza line readable in the chronicle to someone who was not there", async () => {
    const owner = await newHuman("open-speaker");
    const bystander = await newHuman("open-bystander");
    const speaker = await newAgent(owner, `open${tag()}`);
    await enter(speaker, "plaza");

    const body = `open to the world ${tag()}`;
    const ack = await say(speaker, body, { kind: "agent", agent: speaker });
    expect(await spectatorRow(ack.id)).not.toBeNull();

    // The bystander has no delivery row of their own and was never in the room.
    // They may read it because the line was already broadcast to every
    // logged-out viewer of the landing page — the chronicle is not widening
    // anything, it is catching up with the live feed.
    const entry = await chronicleEntry({ humanId: bystander.id, isOperator: false }, ack.id, speaker.id);
    expect(entry).not.toBeNull();
    expect(entry!.body).toBe(body);
    expect(entry!.bodyWithheld).toBe(false);
  });

  it("writes no spectator row for anything the public feed does not carry", async () => {
    const owner = await newHuman("quiet");
    const other = await newHuman("quiet-other");
    const speaker = await newAgent(owner, `quiet${tag()}`);
    const listener = await newAgent(other, `quietear${tag()}`);

    // 1. A room the landing page does not stream.
    await enter(speaker, "library");
    await enter(listener, "library");
    const inLibrary = await say(speaker, `not on the feed ${tag()}`, { kind: "agent", agent: speaker });
    expect(await spectatorRow(inLibrary.id)).toBeNull();

    // 2. A whisper, which is nobody's business but the two of them.
    await clearActorLimiters(redis, speaker.id);
    const whisper = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "whisper",
      targetId: listener.id,
      body: `between us ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });
    expect(await spectatorRow(whisper.id)).toBeNull();

    // 3. The owner channel.
    await clearActorLimiters(redis, speaker.id);
    const toOwner = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "owner_reply",
      body: `just for you ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });
    expect(await spectatorRow(toOwner.id)).toBeNull();
  });

  it("writes no spectator row for an agent the public feed would filter out", async () => {
    const owner = await newHuman("agents-only");
    const bystander = await newHuman("agents-only-bystander");
    const speaker = await newAgent(owner, `agentsonly${tag()}`);
    // May speak to agents, may not speak to humans. The `sse:plaza` publish
    // already refuses this line, because the spectator is a synthetic human.
    const agentsOnly = await grove.identity.patchPolicy(speaker.id, owner, {
      ...DEFAULT_AGENT_POLICY,
      speakToHumans: false,
    });
    await enter(agentsOnly, "plaza");

    const body = `agents only ${tag()}`;
    const ack = await say(agentsOnly, body, { kind: "agent", agent: agentsOnly });

    // This is the line that must not move: the emit is allowed (it still has a
    // mouth for agents), the line exists, and the public feed does not carry it.
    expect(await spectatorRow(ack.id)).toBeNull();

    const entry = await chronicleEntry({ humanId: bystander.id, isOperator: false }, ack.id, agentsOnly.id);
    expect(entry).not.toBeNull();
    expect(entry!.body).toBeNull();
    expect(entry!.bodyWithheld).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(body);
  });

  it("keeps a private channel out of the chronicle entirely", async () => {
    const owner = await newHuman("private-line");
    const bystander = await newHuman("private-bystander");
    const agent = await newAgent(owner, `priv${tag()}`);

    await clearActorLimiters(redis, owner.id);
    const body = `only for you ${tag()}`;
    const instruction = await grove.speech.say({ kind: "human", human: owner }, {
      channel: "owner_instruction",
      targetId: agent.id,
      body,
      idempotencyKey: `k-${tag()}`,
    });
    expect(await spectatorRow(instruction.id)).toBeNull();

    // Not withheld — absent. The chronicle never surfaces a private channel, to
    // anybody, and the spectator row must not have become a side door into one.
    expect(await chronicleEntry({ humanId: bystander.id, isOperator: false }, instruction.id, owner.id)).toBeNull();
    expect(await chronicleEntry({ humanId: owner.id, isOperator: false }, instruction.id, owner.id)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // #60: facing hints come only from lines the public feed carried.
  // -------------------------------------------------------------------------

  it("turns a Plaza speaker toward whom it @mentioned, from the public line alone (#60)", async () => {
    const owner = await newHuman("facing-owner");
    const bystander = await newHuman("facing-bystander");
    const speaker = await newAgent(owner, `facer${tag()}`);
    const listener = await newAgent(owner, `faced${tag()}`);
    await enter(speaker, "plaza");
    await enter(listener, "plaza");

    const ack = await say(speaker, `@${listener.slug} is the build green?`, { kind: "agent", agent: speaker });
    const lines = await grove.world.publicFacingLines();
    expect(lines.map((l) => l.speechId)).toContain(ack.id);

    const map = await grove.world.minimap();
    const hint = map.facing.find((h) => h.from === speaker.id);
    expect(hint).toMatchObject({ from: speaker.id, to: listener.id });
    const ttl = Date.parse(hint!.until) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(20_000);
    // Ids and a time only: the words stay in recentSpeech where they already were.
    expect(Object.keys(hint!).sort()).toEqual(["from", "to", "until"]);

    // Replay rebuilds it from the chronicle: the line is marked as publicly carried.
    const entry = await chronicleEntry({ humanId: bystander.id, isOperator: false }, ack.id, speaker.id);
    expect(entry!.detail).toMatchObject({ channel: "room_say", public: true });
  });

  it("never makes a hint from a whisper, an unbroadcast room, a private space or a lounge (#60)", async () => {
    const owner = await newHuman("facing-quiet");
    const speaker = await newAgent(owner, `fquiet${tag()}`);
    const listener = await newAgent(owner, `fquietear${tag()}`);
    const mention = `@${listener.slug}`;

    // A whisper in the Plaza, both standing there.
    await enter(speaker, "plaza");
    await enter(listener, "plaza");
    await clearActorLimiters(redis, speaker.id);
    const whisper = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "whisper",
      targetId: listener.id,
      body: `${mention} between us ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });

    // A room the public feed does not stream.
    await enter(speaker, "library");
    await enter(listener, "library");
    const library = await say(speaker, `${mention} quiet in here`, { kind: "agent", agent: speaker });

    // A private space: even a forged spectator row does not get past the place gate.
    const space = await grove.campus.createWorld(owner, { name: `Facing ${tag()}`, slug: `facing-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await enter(speaker, `${space.id}:plaza`, space.id);
    await enter(listener, `${space.id}:plaza`, space.id);
    const inside = await say(speaker, `${mention} behind the door`, { kind: "agent", agent: speaker });
    await pg.query(
      `INSERT INTO speech_deliveries (speech_id, recipient_id, status) VALUES ($1, $2, 'delivered') ON CONFLICT DO NOTHING`,
      [inside.id, SPECTATOR_RECIPIENT.id],
    );

    // An owner's lounge line, forged the same way.
    const lounge = await grove.presence.ensureLounge(owner);
    const loungeId = `fct_${tag()}`;
    await pg.query(
      `INSERT INTO speech (id, channel, sender_id, sender_kind, room_id, body, grapheme_count)
       VALUES ($1, 'room_say', $2, 'human', $3, $4, 10)`,
      [loungeId, owner.id, lounge.id, `${mention} in the lounge`],
    );
    await pg.query(`INSERT INTO speech_deliveries (speech_id, recipient_id, status) VALUES ($1, $2, 'delivered')`, [
      loungeId,
      SPECTATOR_RECIPIENT.id,
    ]);

    try {
      const ids = new Set([
        ...(await grove.world.publicFacingLines()).map((l) => l.speechId),
        ...(await grove.world.publicFacingLines(space.id)).map((l) => l.speechId),
      ]);
      for (const id of [whisper.id, library.id, inside.id, loungeId]) expect(ids.has(id)).toBe(false);
      expect((await grove.world.minimap()).facing.some((h) => h.from === speaker.id)).toBe(false);
      expect((await grove.world.minimap(space.id)).facing).toEqual([]);
    } finally {
      await pg.query(`DELETE FROM speech_deliveries WHERE speech_id = $1`, [loungeId]);
      await pg.query(`DELETE FROM speech WHERE id = $1`, [loungeId]);
    }
  });
});
