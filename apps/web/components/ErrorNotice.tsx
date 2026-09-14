"use client";

import { describeApiError, type DescribeOptions } from "@/lib/api-error";
import { GROVE_BASE, gp } from "@/lib/base";
import { RefusalNotice } from "./RefusalNotice";

/**
 * The one error style. Pass whatever the page caught (or a sentence it wrote
 * itself); it says the cause in plain words and what to do next. Kernel
 * refusals are handed to RefusalNotice so they still name the right door.
 *
 * - `live="alert"` (default) for a failure the person just caused;
 *   `live="polite"` for a background refresh that failed quietly.
 * - `tone="drawer"` inside the room drawer: follows the live map theme's
 *   chrome tokens. Pages stay neutral (DECISIONS #3).
 * - `onRetry` shows a Retry button when the failure is worth retrying.
 * - `inline` renders a span, for errors that sit in a row of controls.
 */
export function ErrorNotice({
  error,
  onRetry,
  live = "alert",
  tone = "page",
  inline = false,
  size = "sm",
  className = "",
  ...opts
}: {
  error: unknown;
  onRetry?: () => void;
  live?: "alert" | "polite";
  tone?: "page" | "drawer";
  inline?: boolean;
  /** `xs` where the error sits among small controls. */
  size?: "sm" | "xs";
  className?: string;
} & DescribeOptions) {
  const view = describeApiError(error, opts);
  if (!view) return null;
  if (view.kind === "refused" && view.refusal) {
    return (
      <div className={className}>
        <RefusalNotice input={view.refusal} />
      </div>
    );
  }

  const a11y = live === "alert" ? ({ role: "alert" } as const) : ({ role: "status", "aria-live": "polite" } as const);
  const cause = tone === "drawer" ? "text-white/90" : "text-red-200";
  const link = tone === "drawer" ? "text-lantern-300" : "text-white/85";

  const signInHref = () => {
    const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
    // `next` is resolved with gp() on the login page, so strip our own base.
    const next = GROVE_BASE && here.startsWith(GROVE_BASE) ? here.slice(GROVE_BASE.length) || "/" : here;
    return gp(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  };

  const extras = (
    <>
      {view.signIn ? (
        <a href={signInHref()} className={`ml-1 underline underline-offset-2 ${link}`}>
          {view.fix ?? "Sign in"}
        </a>
      ) : null}
      {onRetry && view.retryable ? (
        <button type="button" onClick={onRetry} className={`ml-2 underline underline-offset-2 ${link}`}>
          Retry
        </button>
      ) : null}
    </>
  );

  if (inline) {
    return (
      <span {...a11y} className={`text-xs ${className}`}>
        <span className={cause}>{view.cause}</span>
        {view.fix && !view.signIn ? <span className="ml-1 text-white/55">{view.fix}</span> : null}
        {extras}
      </span>
    );
  }

  return (
    <div
      {...a11y}
      className={`rounded-lg border ${size === "xs" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"} ${
        tone === "drawer" ? "border-red-400/35 bg-dusk-900/70" : "border-red-400/30 bg-red-500/5"
      } ${className}`}
    >
      <p className={cause}>{view.cause}</p>
      {view.fix || view.signIn || (onRetry && view.retryable) ? (
        <p className="mt-0.5 text-white/60">
          {view.signIn ? null : view.fix}
          {extras}
        </p>
      ) : null}
    </div>
  );
}
