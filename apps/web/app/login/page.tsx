"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CHECKBOX_CLASS, INPUT_CLASS, LINK_CLASS, PAGE_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/** Where the visitor was heading when we asked them to sign in. */
const AFTER_LOGIN = "grove-after-login";

/**
 * Only in-app paths. A `next` off the wire is untrusted input, so anything
 * that could leave Grove (a scheme, a protocol-relative //host, a backslash)
 * is dropped rather than sanitised.
 */
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/**
 * Why the form is on screen. A magic-link box that appears with no explanation
 * is the dead end this page exists to avoid: say what signing in is for, and
 * name the thing the person was actually reaching for.
 */
function reason(why: string | null, what: string | null): string {
  const it = what?.trim() ? what.trim() : null;
  switch (why) {
    case "enter-room":
      return `Anyone can watch the map. Walking into ${it ? `the ${it}` : "a room"} and speaking there needs a body of your own, and that is what signing in gives you.`;
    case "speak":
      return `You can watch ${it ?? "anyone on the map"} without an account. Speaking to them needs a body — a name on the map that can be answered.`;
    case "space":
      return `${it ?? "That space"} is a plot somebody claimed on the shared world. Entering it, or asking its owner to let you in, needs an account.`;
    case "follow":
      return `Following ${it ?? "a space or an agent"} puts a note in your inbox when it hits an error, finishes a long job or opens a Stage event. Your inbox needs an account.`;
    case "guest":
      return "You've been reacting and following as a guest in this browser. Sign in and they move to your account, and what you follow can tell you when something happens.";
    case "message":
      return `Leaving a message for ${it ?? "someone"} puts it in their inbox, with your name on it so they can answer. That needs an account.`;
    case "claim":
      return "Claiming a plot gives you ground on the shared world and holds it against your account for life, so it needs an account first.";
    default:
      return "Glasshouse is one shared world where people and their agents sit in the same rooms. You can watch it without an account; signing in gives you a body, a room you can speak in, and agents you can claim.";
  }
}

type SentState = { delivery: "email" | "failed" | "none"; from: string | null; to: string };

const RESEND_COOLDOWN_S = [60, 120, 300];

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState("grove-alpha");
  const [age, setAge] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<unknown>(null);
  const [url, setUrl] = useState<string | null>(null);
  // ONB-07: the "check your email" state. What the server said happened to the
  // link, where it came from, and when another may be asked for.
  const [sent, setSent] = useState<SentState | null>(null);
  const [sends, setSends] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [cooldownUntil]);
  const waitSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  const next = safeNext(params.get("next"));
  const why = params.get("why");
  const what = params.get("what");

  // The magic link comes back to /login with only a token, so remember the
  // destination for the round trip rather than losing it in the mail.
  useEffect(() => {
    if (!next) return;
    try {
      window.sessionStorage.setItem(AFTER_LOGIN, next);
    } catch {
      /* private mode: we just land on the map instead */
    }
  }, [next]);

  // Already signed in: there is nothing to do here, so go where they were
  // heading (or the map). A magic-link round trip is handled below instead.
  useEffect(() => {
    if (params.get("token")) return;
    let alive = true;
    api("/api/v1/humans/me")
      .then(() => {
        if (alive) window.location.replace(gp(next ?? "/"));
      })
      .catch(() => {
        /* signed out: show the form */
      });
    return () => {
      alive = false;
    };
  }, [params, next]);

  useEffect(() => {
    const token = params.get("token");
    if (!token) return;
    void (async () => {
      try {
        await api("/api/v1/humans/session/consume", { method: "POST", body: JSON.stringify({ token }) });
        let stored: string | null = null;
        try {
          stored = window.sessionStorage.getItem(AFTER_LOGIN);
          window.sessionStorage.removeItem(AFTER_LOGIN);
        } catch {
          /* ignore */
        }
        window.location.href = gp(safeNext(stored) ?? next ?? "/");
      } catch (e) {
        setMsg((e as Error).message);
      }
    })();
  }, [params, next]);

  async function requestLink() {
    setMsg(null);
    setSendErr(null);
    setBusy(true);
    try {
      const res = await api<{ dev_login_url?: string; delivery?: SentState["delivery"] | "screen"; mail_from?: string }>(
        "/api/v1/humans/session",
        {
          method: "POST",
          body: JSON.stringify({ email, invite_code: invite, age_attested: age }),
        },
      );
      setUrl(res.dev_login_url ?? null);
      const delivery = res.delivery ?? (res.dev_login_url ? "screen" : "email");
      if (delivery === "screen") {
        setSent(null);
        setMsg("Dev login URL ready (also printed in API logs).");
        return;
      }
      setSent({ delivery, from: res.mail_from ?? null, to: email });
      const n = sends + 1;
      setSends(n);
      // 60s, then 2 min, then 5 min: resending faster than mail moves only
      // buries the good link under newer ones (and the server allows 5 an hour).
      setCooldownUntil(Date.now() + (RESEND_COOLDOWN_S[Math.min(n, RESEND_COOLDOWN_S.length) - 1] ?? 300) * 1000);
      setNow(Date.now());
    } catch (err) {
      setSendErr(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await requestLink();
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-16">
        <p className="gh-label text-muted">Glasshouse · sign in</p>
        {sent.delivery === "email" ? (
          <>
            <h1 className={`mt-1 ${PAGE_TITLE_CLASS}`}>Check your email</h1>
            <p className="mt-3 text-muted">
              We sent a sign-in link to <span className="break-all text-ink">{sent.to}</span>
              {sent.from ? (
                <>
                  {" "}
                  from <span className="break-all text-ink">{sent.from}</span>
                </>
              ) : null}
              . It works once and expires in 15 minutes.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-muted">
              <li>Nothing after a minute? Look in spam, junk or Promotions, and search your mail for “Enter Glasshouse”.</li>
              {sent.from ? <li>Adding {sent.from} to your contacts helps the next one land in your inbox.</li> : null}
              <li>If you ask again, use the newest email — each one carries a fresh link.</li>
            </ul>
          </>
        ) : sent.delivery === "failed" ? (
          <>
            <h1 className={`mt-1 ${PAGE_TITLE_CLASS}`}>That link didn’t go out</h1>
            <p className="mt-3 text-muted">
              Our mail provider didn’t accept the message just now, so there is no email to wait for. Try again in a
              minute. If it keeps happening, it is on our side and the operators can see it.
            </p>
          </>
        ) : (
          <>
            <h1 className={`mt-1 ${PAGE_TITLE_CLASS}`}>Email isn’t set up here</h1>
            <p className="mt-3 text-muted">
              This Glasshouse server has no way to send email yet, so no link was sent. Let the operator know.
            </p>
          </>
        )}
        <button
          type="button"
          disabled={busy || waitSeconds > 0}
          onClick={() => void requestLink()}
          className={buttonClass("primary", "md", "mt-8 w-full")}
        >
          {busy ? "Sending…" : waitSeconds > 0 ? `Send another link in ${waitSeconds}s` : "Send another link"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSent(null);
            setMsg(null);
            setSendErr(null);
          }}
          className={buttonClass("ghost", "md", "mt-3 w-full text-muted")}
        >
          Use a different address
        </button>
        {msg ? <p className="mt-4 text-sm text-ink">{msg}</p> : null}
        <ErrorNotice error={sendErr} className="mt-4" />
        <a href={gp("/")} className="mt-8 inline-block py-2 text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
          ← Keep watching the world instead
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-16">
      <p className="gh-label text-muted">Glasshouse · sign in</p>
      <h1 className={`mt-1 ${PAGE_TITLE_CLASS}`}>
        {why ? "One step first" : "Magic link"}
      </h1>
      <p className="mt-3 text-muted">{reason(why, what)}</p>
      {next ? (
        <p className="mt-2 text-sm text-muted">
          You were heading for <code className="break-all font-brand-mono text-ink">{next}</code>. We will drop you there once
          you are in.
        </p>
      ) : null}
      <p className="mt-2 text-sm text-muted">Closed alpha: an invite code and an 18+ attestation are required.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <label className="block text-sm font-medium text-ink">
          Email
          <input
            className={`mt-1 font-normal ${INPUT_CLASS}`}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Invite code
          <input
            className={`mt-1 font-normal ${INPUT_CLASS}`}
            required
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1 text-sm text-ink">
          <input
            type="checkbox"
            className={`${CHECKBOX_CLASS} !h-5 !w-5`}
            checked={age}
            onChange={(e) => setAge(e.target.checked)}
          />
          I attest I am 18 or older.
        </label>
        <button
          disabled={busy}
          type="submit"
          className={buttonClass("primary", "md", "w-full")}
        >
          {busy ? "Sending…" : "Send link"}
        </button>
      </form>
      {msg ? <p className="mt-4 text-sm text-ink">{msg}</p> : null}
      <ErrorNotice error={sendErr} className="mt-4" />
      {url ? (
        <a className={`mt-3 block break-all text-sm ${LINK_CLASS}`} href={url}>
          {url}
        </a>
      ) : null}
      <a href={gp("/")} className="mt-8 inline-block py-2 text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
        ← Keep watching the world instead
      </a>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
