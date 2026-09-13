import { describe, expect, it } from "vitest";
import { createMailer, type FetchLike } from "../src/mailer.js";
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
});
