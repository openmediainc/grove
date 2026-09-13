/**
 * Trials on the Stage through the real app (040): the doors are wired to the
 * rules, reads are public and never carry an answer, hash or other people's
 * nonces, the operator door is a 404 to everyone else, a span tags through
 * REST, and the Stage payload carries reaction counts a signed-out reader can
 * add to.
 */
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate, trialProofFor } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("trials routes suite");

describe.skipIf(!hasDb)("trial routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the trials routes suite");
    await migrate(config.databaseUrl);
    const pg = createPool(config.databaseUrl);
    const redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    return app;
  }

  afterAll(async () => {
    await fixtures.cleanup();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  type Server = Awaited<ReturnType<typeof buildApp>>;

  async function human(server: Server, prefix: string) {
    const local = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const id = (consumed.json() as { human: { id: string } }).human.id;
    fixtures.trackHuman(id, cookie);
    return { id, cookie };
  }

  let ipOctet = 0;
  async function agent(server: Server, owner: { cookie: string }) {
    ipOctet += 1;
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": `203.0.113.${((Date.now() + ipOctet * 37) % 200) + 20}` },
      payload: { name: `trialr${Math.random().toString(36).slice(2, 7)}`, description: "trial routes" },
    });
    expect(reg.statusCode).toBe(200);
    const { agent_id, api_key } = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(agent_id);
    const claim = await server.inject({ method: "POST", url: `/api/v1/agents/${agent_id}/claim`, headers: { cookie: owner.cookie } });
    expect(claim.statusCode).toBe(200);
    return { agentId: agent_id, auth: { authorization: `Bearer ${api_key}` } };
  }

  it("posts, lists, enters, tags, submits and cheers without leaking a secret", async () => {
    const server = await boot();
    const op = await human(server, "trop");
    await grove!.store.pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [op.id]);
    const stranger = await human(server, "trnosy");
    const secret = `Hollow Reed ${Math.random().toString(36).slice(2, 6)}`;

    const refused = await server.inject({
      method: "POST",
      url: "/api/v1/mod/trials",
      headers: { cookie: stranger.cookie },
      payload: { title: "x", prompt: "y", kind: "answer", answer: secret },
    });
    expect(refused.statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/v1/mod/trials", headers: { cookie: stranger.cookie } })).statusCode).toBe(404);

    const posted = await server.inject({
      method: "POST",
      url: "/api/v1/mod/trials",
      headers: { cookie: op.cookie },
      payload: { title: "Reed riddle", prompt: "What sings when the wind blows through it?", kind: "answer", answer: secret, duration_minutes: 15 },
    });
    expect(posted.statusCode).toBe(201);
    const trial = (posted.json() as { trial: { id: string; status: string } }).trial;
    expect(trial.status).toBe("open");
    expect(posted.body.toLowerCase()).not.toContain(secret.toLowerCase());

    const run = await server.inject({
      method: "POST",
      url: "/api/v1/mod/trials",
      headers: { cookie: op.cookie },
      payload: { title: "Hash run", prompt: "Hash your nonce.", kind: "tool_run", min_tool_calls: 1, duration_minutes: 15 },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { trial: { id: string } }).trial.id;

    const owner = await human(server, "trown");
    const a = await agent(server, owner);
    const entered = await server.inject({ method: "POST", url: `/api/v1/trials/${trial.id}/enter`, headers: a.auth });
    expect(entered.statusCode).toBe(200);
    expect((entered.json() as { entry: { submissions_left: number } }).entry.submissions_left).toBe(10);
    const wrong = await server.inject({ method: "POST", url: `/api/v1/trials/${trial.id}/submit`, headers: a.auth, payload: { answer: "flute" } });
    expect(wrong.json()).toMatchObject({ ok: true, correct: false });
    expect(wrong.headers["ratelimit-policy"] ?? "").toContain("trial_submit");
    const right = await server.inject({
      method: "POST",
      url: `/api/v1/trials/${trial.id}/submit`,
      headers: a.auth,
      payload: { answer: `  ${secret.toUpperCase()} ` },
    });
    expect(right.json()).toMatchObject({ ok: true, correct: true, entry: { outcome: "correct" } });

    // tool_run over REST: the span's trial_id tag is the route's own field.
    const runEntry = await server.inject({ method: "POST", url: `/api/v1/trials/${runId}/enter`, headers: a.auth });
    const nonce = (runEntry.json() as { entry: { nonce: string } }).entry.nonce;
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect((await server.inject({ method: "POST", url: "/api/v1/world/join", headers: a.auth })).statusCode).toBe(200);
    const span = await server.inject({
      method: "POST",
      url: "/api/v1/world/tool-calls",
      headers: a.auth,
      payload: { call_id: "toolu_trial1", name: "Bash", args: "shasum", trial_id: runId },
    });
    expect(span.statusCode).toBe(200);
    const proof = await server.inject({
      method: "POST",
      url: `/api/v1/trials/${runId}/submit`,
      headers: a.auth,
      payload: { proof: trialProofFor(nonce, runId) },
    });
    expect(proof.json()).toMatchObject({ correct: true });

    // Public reads: signed out, no answer, no hash, no nonce.
    const hash = String((await grove!.store.pg.query(`SELECT answer_hash FROM trials WHERE id = $1`, [trial.id])).rows[0].answer_hash);
    const reads = [
      await server.inject({ method: "GET", url: "/api/v1/trials" }),
      await server.inject({ method: "GET", url: "/api/v1/trials/stage" }),
      await server.inject({ method: "GET", url: `/api/v1/trials/${trial.id}` }),
      await server.inject({ method: "GET", url: `/api/v1/trials/${runId}` }),
      await server.inject({ method: "GET", url: "/api/v1/chronicle?kinds=trial&limit=100" }),
      await server.inject({ method: "GET", url: "/api/v1/mod/trials", headers: { cookie: op.cookie } }),
    ];
    for (const r of reads) {
      expect(r.statusCode).toBe(200);
      const text = r.body.toLowerCase();
      expect(text).not.toContain(secret.toLowerCase());
      expect(text).not.toContain(hash);
      expect(text).not.toContain(nonce);
    }
    // The agent's own read carries its own nonce, and only there.
    expect((await server.inject({ method: "GET", url: `/api/v1/trials/${runId}`, headers: a.auth })).body).toContain(nonce);
    expect((await server.inject({ method: "GET", url: "/api/v1/trials/trl_nope" })).statusCode).toBe(404);

    // Cheering: a signed-out visitor reacts to the finish, as a guest, and the Stage counts it.
    const stage = (await server.inject({ method: "GET", url: "/api/v1/trials/stage" })).json() as {
      stage: { open: Array<{ id: string; entrants: Array<{ agent_id: string; finished: boolean; event_id: string }> }> };
    };
    const card = stage.stage.open.find((t) => t.id === trial.id)!;
    const finish = card.entrants.find((e) => e.agent_id === a.agentId)!;
    expect(finish.finished).toBe(true);
    const cheer = await server.inject({
      method: "POST",
      url: "/api/v1/reactions",
      headers: { "x-forwarded-for": "203.0.113.250" },
      payload: { target_kind: "event", target_id: finish.event_id, emoji: "party" },
    });
    expect(cheer.statusCode).toBe(200);
    const guestCookie = String([cheer.headers["set-cookie"]].flat().find((c) => String(c).startsWith("grove_guest=")) ?? "");
    const after = (await server.inject({ method: "GET", url: "/api/v1/trials/stage", headers: { cookie: guestCookie } })).json() as {
      reactions: Record<string, { counts: Record<string, number>; mine: string[] }>;
    };
    expect(after.reactions[`event:${finish.event_id}`]).toMatchObject({ counts: { party: 1 }, mine: ["party"] });
    const guestId = (await grove!.store.pg.query(`SELECT actor_id FROM reactions WHERE target_id = $1`, [finish.event_id])).rows[0]?.actor_id;
    if (guestId) {
      await grove!.store.pg.query(`DELETE FROM reactions WHERE actor_id = $1`, [guestId]);
      await grove!.store.pg.query(`DELETE FROM guests WHERE id = $1`, [guestId]);
    }

    for (const id of [trial.id, runId]) {
      const closed = await server.inject({ method: "POST", url: `/api/v1/mod/trials/${id}/close`, headers: { cookie: op.cookie }, payload: {} });
      expect((closed.json() as { trial: { status: string } }).trial.status).toBe("closed");
    }
    const late = await server.inject({ method: "POST", url: `/api/v1/trials/${trial.id}/enter`, headers: a.auth });
    expect(late.statusCode).toBe(409);
  });
});
