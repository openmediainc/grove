import { createRequire } from "node:module";
import type { GroveConfig } from "./config.js";

export type MailTransport = "resend" | "smtp" | "stdout" | "noop";

/**
 * What the transport said at the moment of sending. `providerMessageId` is the
 * handle a later event lookup needs; `sent` is false for the transports that
 * never hand the message to anybody (stdout logs it, noop drops it).
 *
 * Accepted is NOT delivered. See email-deliveries.ts.
 */
export interface MailSendResult {
  sent: boolean;
  providerMessageId: string | null;
}

/**
 * A send the transport refused (`rejected`: the provider answered and said no —
 * bad sender domain, invalid key, suppressed address) or could not complete
 * (`error`: network, timeout, 5xx, 429). The distinction matters to an
 * operator: a rejection will not fix itself.
 */
export class MailSendError extends Error {
  constructor(
    public readonly outcome: "rejected" | "error",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

/** Provider-side delivery states, normalised. `null` = the provider has not decided yet. */
export type ProviderDeliveryState = "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

export interface Mailer {
  kind: MailTransport;
  /** The configured From header, e.g. `Grove <noreply@grove.example>`. */
  from: string;
  sendMagicLink(to: string, url: string): Promise<MailSendResult>;
  /**
   * Ask the provider what became of a message. Only transports with an events
   * API implement it (Resend). SMTP hands the message to a relay and never
   * hears another word, which is why redemption rate exists.
   */
  lookupDelivery?(providerMessageId: string): Promise<{ state: ProviderDeliveryState | null; raw: string }>;
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

/** Resend's `last_event` vocabulary mapped onto ours. Unknown / in-flight values map to null. */
export function mapResendEvent(lastEvent: string | undefined | null): ProviderDeliveryState | null {
  switch (lastEvent) {
    case "delivered":
    case "opened":
    case "clicked":
      return "delivered";
    case "delivery_delayed":
      return "delayed";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    case "failed":
    case "canceled":
      return "failed";
    case "sent":
      return "sent";
    default:
      return null; // queued, scheduled, or something new
  }
}

/** A provider error body, clipped and stripped of anything that looks like an address or a link. */
export function scrubProviderText(text: string, max = 200): string {
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[^\s"'<>(),;:]+@[^\s"'<>(),;:]+/g, "<address>")
    .slice(0, max);
}

// nodemailer is CommonJS and this package is ESM: a bare `require` throws
// "require is not defined in ES module scope" the moment GROVE_SMTP_URL is set,
// which took the whole API down at construction. createRequire is the ESM way.
const requireCjs = createRequire(import.meta.url);

export function createMailer(config: GroveConfig, deps: MailerDeps = {}): Mailer {
  const from = config.mailFrom ?? "Grove <noreply@localhost>";
  if (config.resendApiKey) {
    const fetchFn = deps.fetch ?? (globalThis.fetch as FetchLike);
    const key = config.resendApiKey;
    return {
      kind: "resend",
      from,
      async sendMagicLink(to, url) {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await fetchFn("https://api.resend.com/emails", {
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
        } catch (err) {
          throw new MailSendError("error", `resend unreachable: ${scrubProviderText((err as Error).message)}`);
        }
        const body = await res.text();
        if (!res.ok) {
          // 429 and 5xx are the provider's weather; any other 4xx is a refusal
          // that will repeat on every retry until somebody changes config.
          const outcome = res.status === 429 || res.status >= 500 ? "error" : "rejected";
          throw new MailSendError(outcome, `resend ${res.status}: ${scrubProviderText(body)}`, res.status);
        }
        let id: string | null = null;
        try {
          id = (JSON.parse(body) as { id?: string }).id ?? null;
        } catch {
          /* accepted without a parsable id: still accepted, just unpollable */
        }
        return { sent: true, providerMessageId: id };
      },
      async lookupDelivery(providerMessageId) {
        const res = await fetchFn(`https://api.resend.com/emails/${encodeURIComponent(providerMessageId)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
        });
        const body = await res.text();
        if (!res.ok) throw new MailSendError("error", `resend lookup ${res.status}: ${scrubProviderText(body)}`, res.status);
        const lastEvent = (JSON.parse(body) as { last_event?: string }).last_event ?? null;
        return { state: mapResendEvent(lastEvent), raw: lastEvent ?? "none" };
      },
    };
  }
  if (config.smtpUrl) {
    const factory =
      deps.createSmtp ??
      ((url: string) => {
        const nodemailer = requireCjs("nodemailer") as { createTransport: (u: string) => ReturnType<SmtpFactory> };
        return nodemailer.createTransport(url);
      });
    const transport = factory(config.smtpUrl);
    return {
      kind: "smtp",
      from,
      async sendMagicLink(to, url) {
        let info: { messageId?: string; rejected?: unknown[]; response?: string } | undefined;
        try {
          info = (await transport.sendMail({
            from,
            to,
            subject: "Enter Grove",
            html: magicHtml(url),
            text: `Enter Grove: ${url}`,
          })) as typeof info;
        } catch (err) {
          const e = err as Error & { responseCode?: number };
          // An SMTP 5xx is a permanent refusal; anything else (connect, 4xx) is transient.
          const outcome = e.responseCode && e.responseCode >= 500 ? "rejected" : "error";
          throw new MailSendError(outcome, `smtp: ${scrubProviderText(e.message)}`, e.responseCode ?? null);
        }
        if (Array.isArray(info?.rejected) && info.rejected.length > 0) {
          throw new MailSendError("rejected", `smtp relay rejected the recipient: ${scrubProviderText(info.response ?? "")}`);
        }
        return { sent: true, providerMessageId: info?.messageId ?? null };
      },
    };
  }
  if (config.magicLinkStdout) {
    return {
      kind: "stdout",
      from,
      async sendMagicLink() {
        /* identity logs the URL */
        return { sent: false, providerMessageId: null };
      },
    };
  }
  return {
    kind: "noop",
    from,
    async sendMagicLink() {
      /* production without mail config: token is still stored, and nobody will ever see it */
      return { sent: false, providerMessageId: null };
    },
  };
}
