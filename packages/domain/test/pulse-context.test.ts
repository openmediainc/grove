import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  isStalledPulse,
  normalisePulseError,
  normalisePulseUrl,
  PULSE_ERROR_MAX,
  PULSE_URL_MAX,
  pulseAgeSeconds,
  STALL_AFTER_SECONDS,
} from "../src/services/presence.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.pulseContext;

// ---------------------------------------------------------------------------
// Pure rules. No database, so these run under `pnpm test:units` too.
// ---------------------------------------------------------------------------

describe("pulse url validation", () => {
  it("accepts https and http", () => {
    expect(normalisePulseUrl("https://github.com/grove/grove/pull/42")).toBe(
      "https://github.com/grove/grove/pull/42",
    );
    expect(normalisePulseUrl("http://localhost:3000/runs/7")).toBe("http://localhost:3000/runs/7");
  });

  it("treats absent or blank as no url at all", () => {
    expect(normalisePulseUrl(null)).toBeNull();
    expect(normalisePulseUrl(undefined)).toBeNull();
    expect(normalisePulseUrl("   ")).toBeNull();
  });

  // This string renders as a link in somebody's browser. A scheme that is not
  // http(s) is refused outright rather than stored and filtered downstream.
  it("rejects javascript: and every other scheme", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(document.cookie)  ",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "mailto:ops@example.com",
      "ftp://example.com/x",
      "vbscript:msgbox(1)",
    ]) {
      expect(() => normalisePulseUrl(bad)).toThrowError(/http/i);
    }
  });

  it("rejects anything that is not an absolute URL", () => {
    for (const bad of ["not a url", "/pulls/42", "example.com/x"]) {
      expect(() => normalisePulseUrl(bad)).toThrowError(/absolute/i);
    }
  });

  it("caps length, and rejects rather than truncating a url", () => {
    const long = `https://example.com/${"a".repeat(PULSE_URL_MAX)}`;
    expect(long.length).toBeGreaterThan(PULSE_URL_MAX);
    expect(() => normalisePulseUrl(long)).toThrowError(/512/);
    const ok = `https://example.com/${"a".repeat(PULSE_URL_MAX - 21)}`;
    expect(ok.length).toBeLessThanOrEqual(PULSE_URL_MAX);
    expect(normalisePulseUrl(ok)).toBe(ok);
  });
});

describe("pulse error text", () => {
  it("truncates at the cap instead of refusing a fault report", () => {
    const out = normalisePulseError("x".repeat(PULSE_ERROR_MAX + 500));
    expect(out).toHaveLength(PULSE_ERROR_MAX);
  });

  it("treats blank as none", () => {
    expect(normalisePulseError("")).toBeNull();
    expect(normalisePulseError("  ")).toBeNull();
    expect(normalisePulseError(null)).toBeNull();
  });
});

describe("stall detection", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("measures pulse age in seconds", () => {
    expect(pulseAgeSeconds(ago(90), now)).toBe(90);
    expect(pulseAgeSeconds(null, now)).toBeNull();
  });

  it("does not flag a body just either side of the threshold", () => {
    expect(isStalledPulse("tool", ago(STALL_AFTER_SECONDS - 1), now)).toBe(false);
    expect(isStalledPulse("tool", ago(STALL_AFTER_SECONDS), now)).toBe(false);
    expect(isStalledPulse("tool", ago(STALL_AFTER_SECONDS + 1), now)).toBe(true);
  });

  it("leaves a healthy poller rhythm alone", () => {
    // HTTP pollers heartbeat every 120s and the map holds a pulse fresh for 90s.
    expect(isStalledPulse("think", ago(90), now)).toBe(false);
    expect(isStalledPulse("read", ago(120), now)).toBe(false);
  });

  it("flags every active verb but never rest or silence", () => {
    for (const verb of ["think", "tool", "read", "say", "wait", "error", "blocked"]) {
      expect(isStalledPulse(verb, ago(600), now)).toBe(true);
    }
    for (const verb of ["idle", "offline"]) {
      expect(isStalledPulse(verb, ago(600), now)).toBe(false);
    }
    // Never pulsed = claims nothing = not a stall.
    expect(isStalledPulse("tool", null, now)).toBe(false);
    expect(isStalledPulse(null, ago(600), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round trip. Writes real rows, so it refuses any database not named *_test
// (see space-access.test.ts: importing the domain package loads .env, so a
// bare "is DATABASE_URL set?" check is not enough).
// ---------------------------------------------------------------------------

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("pulse context reaches the minimap", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  // Shared apparatus: foreign-key ordered sweep, protected-id guards,
  // derive-don't-trust owner sweeps, loud on failure. See ./support/fixtures.ts.
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

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
    // Own bucket, so clearing it cannot disturb a test file running in parallel.
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner);
  }

  /** The pulse cap is 1/s; fixtures pulse back to back on purpose. */
  async function unthrottle(id: string) {
    await clearActorLimiters(redis, id);
  }

  /** A body in the library, ready to pulse. */
  async function inhabitant(name: string) {
    const owner = await newHuman(`pulse-${name}`);
    const agent = await newAgent(owner, `${name}${tag()}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "library", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    return agent;
  }

  async function pulse(
    id: string,
    verb: string,
    detail?: string | null,
    ctx?: { url?: string | null; errorText?: string | null },
  ) {
    await unthrottle(id);
    return grove.presence.pulse(id, verb as never, detail ?? null, ctx);
  }

  async function bodyOnMap(id: string) {
    const map = await grove.world.minimap();
    return map.bodies.find((b) => b.id === id);
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the pulse context suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    // cleanup() throws if anything failed to delete, so a leak fails the suite
    // loudly. Close the connections either way.
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  it("a plain {verb} pulse behaves exactly as before", async () => {
    const agent = await inhabitant("plain");
    const p = await pulse(agent.id, "tool", "running the suite");
    expect(p.verb).toBe("tool");
    expect(p.detail).toBe("running the suite");
    expect(p.activity).toBe("working");
    expect(p.pulsedAt).toBeTruthy();
    expect(p.url ?? null).toBeNull();
    expect(p.errorText ?? null).toBeNull();

    const body = await bodyOnMap(agent.id);
    expect(body).toMatchObject({ verb: "tool", url: null, errorText: null, stalled: false });
    expect(body!.pulseAgeSeconds).toBeLessThan(5);
  });

  it("carries a url, keeps it across phases, and drops it at offline", async () => {
    const agent = await inhabitant("link");
    const pr = "https://github.com/grove/grove/pull/42";
    const withUrl = await pulse(agent.id, "tool", "pnpm test:safe", { url: pr });
    expect(withUrl.url).toBe(pr);

    // Sticky: an agent names its PR once and keeps pulsing phases against it.
    const later = await pulse(agent.id, "think", "reading the failure");
    expect(later.url).toBe(pr);

    const replaced = await pulse(agent.id, "read", "the ticket", {
      url: "https://linear.app/grove/issue/GRV-9",
    });
    expect(replaced.url).toBe("https://linear.app/grove/issue/GRV-9");

    const gone = await pulse(agent.id, "offline", "shutting down");
    expect(gone.url).toBeNull();
  });

  it("refuses a javascript: url and writes nothing", async () => {
    const agent = await inhabitant("evil");
    await expect(pulse(agent.id, "tool", "ok", { url: "javascript:alert(1)" })).rejects.toMatchObject({
      code: "INVALID",
    });
    const after = await grove.presence.getPresence(agent.id);
    expect(after!.verb ?? null).toBeNull();
    expect(after!.url ?? null).toBeNull();
    // Validation runs before the quota is spent, so the body can still pulse.
    const good = await grove.presence.pulse(agent.id, "tool" as never, "ok");
    expect(good.verb).toBe("tool");
  });

  it("round-trips error_text to the minimap and clears it on recovery", async () => {
    const agent = await inhabitant("fault");
    const text = "TypeError: cannot read properties of undefined (reading 'rows')";
    const faulted = await pulse(agent.id, "error", "worker crashed", {
      errorText: text,
      url: "https://ci.example.com/runs/1881",
    });
    expect(faulted.errorText).toBe(text);

    const body = await bodyOnMap(agent.id);
    expect(body).toMatchObject({
      verb: "error",
      detail: "worker crashed",
      errorText: text,
      url: "https://ci.example.com/runs/1881",
    });
    // When it happened: the UI needs a timestamp, not just a red glyph.
    expect(body!.pulsedAt).toBeTruthy();

    // A fault caption must not outlive the fault.
    const recovered = await pulse(agent.id, "think", "retrying");
    expect(recovered.errorText).toBeNull();
    expect((await bodyOnMap(agent.id))!.errorText).toBeNull();
  });

  it("ignores error_text on a healthy verb and truncates an overlong one", async () => {
    const agent = await inhabitant("caps");
    const healthy = await pulse(agent.id, "tool", "fine", { errorText: "not a fault" });
    expect(healthy.errorText).toBeNull();
    const blocked = await pulse(agent.id, "blocked", "needs a human", {
      errorText: "y".repeat(PULSE_ERROR_MAX + 200),
    });
    expect(blocked.errorText).toHaveLength(PULSE_ERROR_MAX);
  });

  it("shows a body still claiming `tool` past the threshold as stalled", async () => {
    const agent = await inhabitant("stall");
    await pulse(agent.id, "tool", "long build");
    expect((await bodyOnMap(agent.id))!.stalled).toBe(false);

    // Just inside the window: a slow tool call is not a crash.
    await pg.query(
      `UPDATE presence SET pulsed_at = now() - make_interval(secs => $2) WHERE actor_id = $1`,
      [agent.id, STALL_AFTER_SECONDS - 30],
    );
    const fresh = await bodyOnMap(agent.id);
    expect(fresh!.stalled).toBe(false);
    expect(fresh!.pulseAgeSeconds).toBeGreaterThanOrEqual(STALL_AFTER_SECONDS - 31);

    // Past it: the runtime is gone, and says so before presence gives up at 5 min.
    await pg.query(
      `UPDATE presence SET pulsed_at = now() - make_interval(secs => $2) WHERE actor_id = $1`,
      [agent.id, STALL_AFTER_SECONDS + 30],
    );
    const stale = await bodyOnMap(agent.id);
    expect(stale!.stalled).toBe(true);
    expect(stale!.verb).toBe("tool");

    // An idle body that old is at rest, not stalled.
    await pulse(agent.id, "idle", "turn finished");
    await pg.query(
      `UPDATE presence SET pulsed_at = now() - make_interval(secs => $2) WHERE actor_id = $1`,
      [agent.id, STALL_AFTER_SECONDS * 3],
    );
    expect((await bodyOnMap(agent.id))!.stalled).toBe(false);
  });

  it("publishes the threshold so no client has to guess it", async () => {
    const map = await grove.world.minimap();
    expect(map.stallAfterSeconds).toBe(STALL_AFTER_SECONDS);
  });
});
