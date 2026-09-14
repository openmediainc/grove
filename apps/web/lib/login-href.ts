import { gp } from "@/lib/base";

/**
 * A login link that knows why it was followed. `next` is where the person was
 * actually heading; the login page reads it back so the ask never arrives
 * unannounced.
 */
export function loginHref(opts: { next?: string; why?: string; what?: string }): string {
  const q = new URLSearchParams();
  if (opts.next) q.set("next", opts.next);
  if (opts.why) q.set("why", opts.why);
  if (opts.what) q.set("what", opts.what);
  const s = q.toString();
  return gp(`/login${s ? `?${s}` : ""}`);
}
