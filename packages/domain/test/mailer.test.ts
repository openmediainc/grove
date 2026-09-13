import { describe, expect, it } from "vitest";
import { createMailer, MailSendError, mapResendEvent, scrubProviderText, type FetchLike } from "../src/mailer.js";
import type { GroveConfig } from "../src/config.js";

function cfg(over: Partial<GroveConfig> = {}): GroveConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://x",
    publicUrl: "http://localhost:3000",
    webOrigin: "http://localhost:3000",
    magicLinkStdout: false,
    inviteBootstrap: "grove-alpha",
    operatorEmail: null,
    bootstrapOperator: false,
    migrateOnBoot: false,
    nodeEnv: "test",
    apiPort: 3001,
    listenHost: "127.0.0.1",
    xaiApiKey: null,
    xaiBaseUrl: "https://api.x.ai/v1",
    xaiModel: "grok-4.6",
    resendApiKey: null,
    mailFrom: "Grove <grove@example.com>",
    smtpUrl: null,
    publicDeploy: false,
    ...over,
  };
}

describe("mailer selection", () => {
  it("uses Resend when RESEND_API_KEY is set", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const mailer = createMailer(cfg({ resendApiKey: "re_test" }), { fetch: fetchMock });
    expect(mailer.kind).toBe("resend");
    await mailer.sendMagicLink("a@b.c", "http://localhost:3000/login?token=abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer re_test");
    const payload = JSON.parse(String(calls[0]?.init?.body)) as { html: string; subject: string };
    expect(payload.subject).toBe("Enter Grove");
    expect(payload.html).toContain("Enter Grove");
    expect(payload.html).toContain("http://localhost:3000/login?token=abc");
  });

  it("uses SMTP when GROVE_SMTP_URL is set and Resend is not", async () => {
    const sent: unknown[] = [];
    const mailer = createMailer(cfg({ smtpUrl: "smtp://user:pass@localhost:587" }), {
      createSmtp: () => ({
        sendMail: async (opts) => {
          sent.push(opts);
          return {};
        },
      }),
    });
    expect(mailer.kind).toBe("smtp");
    await mailer.sendMagicLink("a@b.c", "http://localhost:3000/login?token=abc");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "a@b.c", subject: "Enter Grove" });
  });

  it("prefers Resend over SMTP", () => {
    const mailer = createMailer(
      cfg({ resendApiKey: "re_test", smtpUrl: "smtp://localhost:587" }),
      { fetch: async () => ({ ok: true, status: 200, text: async () => "" }) },
    );
    expect(mailer.kind).toBe("resend");
  });

  it("stdout when magicLinkStdout and no transport", () => {
    const mailer = createMailer(cfg({ magicLinkStdout: true }));
    expect(mailer.kind).toBe("stdout");
  });

  it("noop when production has no mail config", () => {
    const mailer = createMailer(cfg({ nodeEnv: "production", magicLinkStdout: false }));
    expect(mailer.kind).toBe("noop");
  });

  it("builds the real SMTP transport under ESM without throwing (was: require is not defined)", () => {
    const mailer = createMailer(cfg({ smtpUrl: "smtp://user:pass@127.0.0.1:2525" }));
    expect(mailer.kind).toBe("smtp");
  });
});

async function failure(p: Promise<unknown>): Promise<MailSendError> {
  try {
    await p;
  } catch (e) {
    return e as MailSendError;
  }
  throw new Error("expected the send to fail");
}

describe("ONB-07: what the provider actually said", () => {
  const reply = (status: number, body: string): FetchLike => async () => ({ ok: status < 400, status, text: async () => body });

  it("returns Resend's message id on acceptance", async () => {
    const mailer = createMailer(cfg({ resendApiKey: "re_test" }), { fetch: reply(200, '{"id":"4ef9a417"}') });
    await expect(mailer.sendMagicLink("a@b.c", "http://x/login?token=t")).resolves.toEqual({
      sent: true,
      providerMessageId: "4ef9a417",
    });
  });

  it("a 4xx is a rejection, a 429/5xx or a dead socket is an error, and neither echoes the address", async () => {
    const rejected = createMailer(cfg({ resendApiKey: "re_test" }), {
      fetch: reply(403, '{"message":"The grove.test domain is not verified for a@b.c"}'),
    });
    const err = await failure(rejected.sendMagicLink("a@b.c", "http://x"));
    expect(err).toBeInstanceOf(MailSendError);
    expect(err.outcome).toBe("rejected");
    expect(err.message).not.toContain("a@b.c");

    const limited = createMailer(cfg({ resendApiKey: "re_test" }), { fetch: reply(429, "slow down") });
    expect((await failure(limited.sendMagicLink("a@b.c", "http://x"))).outcome).toBe("error");

    const dead = createMailer(cfg({ resendApiKey: "re_test" }), {
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect((await failure(dead.sendMagicLink("a@b.c", "http://x"))).outcome).toBe("error");
  });

  it("an SMTP relay that rejects the recipient is a rejection, not a success", async () => {
    const mailer = createMailer(cfg({ smtpUrl: "smtp://x" }), {
      createSmtp: () => ({ sendMail: async () => ({ messageId: "<m@x>", rejected: ["a@b.c"], response: "550 no such user a@b.c" }) }),
    });
    const err = await failure(mailer.sendMagicLink("a@b.c", "http://x"));
    expect(err.outcome).toBe("rejected");
    expect(err.message).not.toContain("a@b.c");
  });

  it("stdout and noop report that nothing was sent", async () => {
    await expect(createMailer(cfg({ magicLinkStdout: true })).sendMagicLink("a@b.c", "u")).resolves.toMatchObject({ sent: false });
    await expect(createMailer(cfg()).sendMagicLink("a@b.c", "u")).resolves.toMatchObject({ sent: false });
  });

  it("looks up delivery through Resend's events and maps last_event", async () => {
    const calls: string[] = [];
    const mailer = createMailer(cfg({ resendApiKey: "re_test" }), {
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => '{"id":"e1","last_event":"bounced"}' };
      },
    });
    await expect(mailer.lookupDelivery!("e1")).resolves.toEqual({ state: "bounced", raw: "bounced" });
    expect(calls[0]).toBe("https://api.resend.com/emails/e1");
    expect(mapResendEvent("clicked")).toBe("delivered");
    expect(mapResendEvent("queued")).toBeNull();
    expect(scrubProviderText("see https://x.y/z?token=abc for p@q.r")).toBe("see <url> for <address>");
  });
});
