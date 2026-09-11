import type { GroveConfig } from "./config.js";

export interface Mailer {
  kind: "resend" | "smtp" | "stdout" | "noop";
  sendMagicLink(to: string, url: string): Promise<void>;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type SmtpFactory = (url: string) => {
  sendMail(opts: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
};

export interface MailerDeps {
  fetch?: FetchLike;
  createSmtp?: SmtpFactory;
}

function magicHtml(url: string): string {
  return `<!doctype html>
<html><body style="margin:0;background:#070814;color:#f4efe4;font-family:Georgia,serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="letter-spacing:0.2em;text-transform:uppercase;color:#e8b86d;font-size:12px">Grove</p>
    <h1 style="font-size:28px;color:#e8b86d">Enter the campus</h1>
    <p>Tap the button to finish signing in. This link expires in 15 minutes.</p>
    <p style="margin:28px 0">
      <a href="${url}" style="background:#e8b86d;color:#070814;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Enter Grove</a>
    </p>
    <p style="font-size:12px;color:#9ca3af">If you did not request this, you can ignore the email.</p>
  </div>
</body></html>`;
}

export function createMailer(config: GroveConfig, deps: MailerDeps = {}): Mailer {
  const from = config.mailFrom ?? "Grove <noreply@localhost>";
  if (config.resendApiKey) {
    const fetchFn = deps.fetch ?? (globalThis.fetch as FetchLike);
    const key = config.resendApiKey;
    return {
      kind: "resend",
      async sendMagicLink(to, url) {
        const res = await fetchFn("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject: "Enter Grove",
            html: magicHtml(url),
            text: `Enter Grove: ${url}`,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
        }
      },
    };
  }
  if (config.smtpUrl) {
    const factory =
      deps.createSmtp ??
      ((url: string) => {
        // Lazy require so unit tests can inject a mock without nodemailer.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodemailer = require("nodemailer") as { createTransport: (u: string) => ReturnType<SmtpFactory> };
        return nodemailer.createTransport(url);
      });
    const transport = factory(config.smtpUrl);
    return {
      kind: "smtp",
      async sendMagicLink(to, url) {
        await transport.sendMail({
          from,
          to,
          subject: "Enter Grove",
          html: magicHtml(url),
          text: `Enter Grove: ${url}`,
        });
      },
    };
  }
  if (config.magicLinkStdout) {
    return {
      kind: "stdout",
      async sendMagicLink() {
        /* identity logs the URL */
      },
    };
  }
  return {
    kind: "noop",
    async sendMagicLink() {
      /* production without mail config: token is still stored */
    },
  };
}
