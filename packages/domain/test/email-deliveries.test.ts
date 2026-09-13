import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, IdentityService } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { MailSendError, type Mailer, type ProviderDeliveryState } from "../src/mailer.js";
import {
  assessEmailHealth,
  checkSenderDns,
  EmailDeliveryService,
  fromAddress,
  maskEmail,
  sha256,
  type EmailHealthInput,
  type WindowStats,
} from "../src/services/email-deliveries.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

/**
 * ONB-07. The pure half (verdict thresholds, DNS parsing, masking) runs
 * everywhere; the ledger half needs the *_test database.
 */

function win(over: Partial<WindowStats> = {}): WindowStats {
  return {
    hours: 24,
    attempts: 0,
    accepted: 0,
    rejected: 0,
    errored: 0,
    notSent: 0,
    pending: 0,
    sendFailureRate: null,
    delivered: 0,
    delayed: 0,
    bounced: 0,
    complained: 0,
    deliveryFailed: 0,
    deliveryUnknown: 0,
    issued: 0,
    redeemed: 0,
    expiredUnredeemed: 0,
    awaiting: 0,
    recipientsIn: 0,
    recipientsStranded: 0,
    recipientRedeemRate: null,
    redeemSecondsP50: null,
    redeemSecondsP90: null,
    lastAttemptAt: null,
    lastAcceptedAt: null,
    lastRedeemedAt: null,
    ...over,
  };
}

function input(over: Partial<EmailHealthInput> = {}): EmailHealthInput {
  return { transport: "resend", production: true, hour: win({ hours: 1 }), day: win(), recentSendStatuses: [], dns: null, ...over };
}

describe("assessEmailHealth", () => {
  it("a production server with no transport is DOWN, not green", () => {
    const v = assessEmailHealth(input({ transport: "noop" }));
    expect(v.status).toBe("down");
    expect(v.reasons[0]?.code).toBe("NO_TRANSPORT");
  });

  it("stdout is honestly unconfigured", () => {
    expect(assessEmailHealth(input({ transport: "stdout" })).status).toBe("unconfigured");
  });

  it("three failed sends in a row is down", () => {
    const v = assessEmailHealth(input({ recentSendStatuses: ["rejected", "error", "rejected", "accepted"] }));
    expect(v.status).toBe("down");
    expect(v.reasons.map((r) => r.code)).toContain("SEND_FAILING");
  });

  it("one old failure behind a success is not down", () => {
    expect(assessEmailHealth(input({ recentSendStatuses: ["accepted", "rejected", "rejected"] })).status).toBe("ok");
  });

  it("half the last hour failing is down", () => {
    const v = assessEmailHealth(input({ hour: win({ hours: 1, attempts: 4, rejected: 2, sendFailureRate: 0.5 }) }));
    expect(v.status).toBe("down");
  });

  it("complaints, bounces and stranded recipients degrade", () => {
    const v = assessEmailHealth(
      input({
        day: win({ accepted: 10, bounced: 1, complained: 1, recipientsIn: 1, recipientsStranded: 3, recipientRedeemRate: 0.25 }),
      }),
    );
    expect(v.status).toBe("degraded");
    expect(v.reasons.map((r) => r.code).sort()).toEqual(["BOUNCES", "COMPLAINTS", "LINKS_NOT_REDEEMED"]);
  });

  it("missing sender DNS degrades", () => {
    const v = assessEmailHealth(
      input({
        dns: {
          domain: "x.test",
          checkedAt: "",
          spf: { name: "x.test", present: false, record: null, checked: ["send.x.test", "x.test"] },
          dkim: { name: "resend._domainkey.x.test", selector: "resend", present: true, record: "p=…" },
          dmarc: { name: "_dmarc.x.test", present: false, record: null, policy: null },
          error: null,
        },
      }),
    );
    expect(v.status).toBe("degraded");
    expect(v.reasons.map((r) => r.code).sort()).toEqual(["DNS_DMARC_MISSING", "DNS_SPF_MISSING"]);
  });
});

describe("checkSenderDns", () => {
  it("finds SPF on the Resend return-path subdomain, DKIM by selector, and the DMARC policy", async () => {
    const zone: Record<string, string[][]> = {
      "send.grove.test": [["v=spf1 include:amazonses.com ~all"]],
      "resend._domainkey.grove.test": [["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ", "CDEF"]],
      "_dmarc.grove.test": [["v=DMARC1; p=quarantine; rua=mailto:d@grove.test"]],
    };
    const resolve = async (name: string) => {
      if (zone[name]) return zone[name]!;
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    };
    const r = await checkSenderDns("grove.test", { transport: "resend", resolve });
    expect(r.error).toBeNull();
    expect(r.spf).toMatchObject({ present: true, name: "send.grove.test" });
    expect(r.dkim).toMatchObject({ present: true, selector: "resend" });
    expect(r.dmarc).toMatchObject({ present: true, policy: "quarantine" });
  });

  it("SMTP without a selector leaves DKIM unchecked rather than guessing", async () => {
    const r = await checkSenderDns("grove.test", {
      transport: "smtp",
      resolve: async () => {
        throw Object.assign(new Error("nope"), { code: "ENODATA" });
      },
    });
    expect(r.dkim.present).toBeNull();
    expect(r.spf.present).toBe(false);
    expect(r.error).toBeNull();
  });
});

describe("helpers", () => {
  it("masks and parses", () => {
    expect(maskEmail("pat@teqdr.com")).toBe("p***@teqdr.com");
    expect(fromAddress("Grove <noreply@grove.test>")).toBe("noreply@grove.test");
    expect(fromAddress("noreply@grove.test")).toBe("noreply@grove.test");
  });
});

// ---------------------------------------------------------------------------

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("email delivery ledger", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const domain = `deliv-${Math.random().toString(36).slice(2, 8)}.example`;

  let mode: "accept" | "reject" | "throw" = "accept";
  let lookupState: ProviderDeliveryState | null = "delivered";
  let nextId = 0;
  const mailer: Mailer = {
    kind: "resend",
    from: "Grove <noreply@grove.test>",
    async sendMagicLink() {
      if (mode === "reject") throw new MailSendError("rejected", "resend 403: domain not verified", 403);
      if (mode === "throw") throw new Error("socket hang up");
      return { sent: true, providerMessageId: `re_${++nextId}` };
    },
    async lookupDelivery() {
      return { state: lookupState, raw: lookupState ?? "queued" };
    },
  };
  let deliveries: EmailDeliveryService;
  let identity: IdentityService;

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the email delivery suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    deliveries = new EmailDeliveryService(grove.store, mailer);
    identity = new IdentityService(grove.store, grove.quota, grove.flags, mailer, deliveries);
  });

  afterAll(async () => {
    await pg?.query("DELETE FROM email_deliveries WHERE recipient_domain = $1", [domain]);
    await fixtures.cleanup();
    await pg?.end();
    redis?.disconnect();
  });

  async function ask(local: string) {
    const email = `${local}@${domain}`;
    await redis.del(`ratelimit:email:${email}:magic:hour`);
    return identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
  }

  async function row(token: string) {
    const { rows } = await pg.query("SELECT * FROM email_deliveries WHERE token_hash = $1", [sha256(token)]);
    return rows[0] as Record<string, unknown>;
  }

  it("records an accepted send without the address or the token in plain", async () => {
    mode = "accept";
    const res = await ask("accepted");
    expect(res.sendStatus).toBe("accepted");
    const r = await row(res.token);
    expect(r.send_status).toBe("accepted");
    expect(r.delivery_status).toBe("unknown");
    expect(String(r.provider_message_id)).toMatch(/^re_/);
    expect(r.recipient_hint).toBe(`a***@${domain}`);
    expect(JSON.stringify(r)).not.toContain(`accepted@${domain}`);
    expect(JSON.stringify(r)).not.toContain(res.token);
    expect(r.next_poll_at).not.toBeNull();
  });

  it("a rejection and a network error are recorded as different things, and login is not thrown", async () => {
    mode = "reject";
    const rejected = await ask("rejected");
    expect(rejected.sendStatus).toBe("rejected");
    expect((await row(rejected.token)).send_error).toContain("403");
    mode = "throw";
    const errored = await ask("errored");
    expect(errored.sendStatus).toBe("error");
    expect((await row(errored.token)).next_poll_at).toBeNull();
    mode = "accept";
  });

  it("polls the provider and settles on a final state", async () => {
    const res = await ask("polled");
    await pg.query("UPDATE email_deliveries SET next_poll_at = now() - interval '1 second' WHERE token_hash = $1", [
      sha256(res.token),
    ]);
    lookupState = "bounced";
    // Other rows in a shared test db may be due too; poll until ours moved.
    for (let i = 0; i < 5 && (await row(res.token)).delivery_status === "unknown"; i++) await deliveries.pollDue(50);
    const r = await row(res.token);
    expect(r.delivery_status).toBe("bounced");
    expect(r.next_poll_at).toBeNull();
    expect(Number(r.polls)).toBeGreaterThanOrEqual(1);
    lookupState = "delivered";
  });

  it("marks redemption and measures time to redeem", async () => {
    const res = await ask("redeemer");
    const { human } = await identity.consumeMagicLink(res.token);
    fixtures.trackHuman(human.id);
    const r = await row(res.token);
    expect(r.redeemed_at).not.toBeNull();
    const recent = await deliveries.recent(200);
    const mine = recent.find((d) => d.recipientHint === `r***@${domain}`);
    expect(mine?.redeemSeconds).not.toBeNull();
    const day = await deliveries.windowStats(24);
    expect(day.redeemed).toBeGreaterThanOrEqual(1);
    expect(day.recipientsIn).toBeGreaterThanOrEqual(1);
  });

  it("counts a person who asked twice and used the second link as IN, not stranded", async () => {
    const first = await ask("twice");
    const second = await ask("twice");
    // Age the first link past its expiry, redeem the second.
    await pg.query("UPDATE email_deliveries SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
      sha256(first.token),
    ]);
    const { human } = await identity.consumeMagicLink(second.token);
    fixtures.trackHuman(human.id);
    const { rows } = await pg.query(
      `SELECT bool_or(redeemed_at IS NOT NULL) AS got_in FROM email_deliveries
        WHERE recipient_hash = (SELECT recipient_hash FROM email_deliveries WHERE token_hash = $1)`,
      [sha256(first.token)],
    );
    expect(rows[0]?.got_in).toBe(true);
  });

  it("health() reports the real transport and the provider-events source of truth", async () => {
    const h = await deliveries.health();
    expect(h.transport).toBe("resend");
    expect(h.deliveryTruth).toBe("provider_events_polled");
    expect(["ok", "degraded", "down"]).toContain(h.status);
  });
});
