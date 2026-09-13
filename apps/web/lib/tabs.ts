/**
 * `?tab=` on the one-subject pages (agent `/a/[slug]`, space `/s/[slug]`).
 *
 * Pure. The first tab is the default and is never written, so a plain link
 * stays plain. A tab the viewer may not open (an owner-only tab for a
 * non-owner) falls back to the default: hiding it is tidiness, the API refuses
 * every owner write anyway.
 */
export const TAB_PARAM = "tab";

export function readTabParam<T extends string>(
  search: string,
  tabs: readonly T[],
  allowed: (tab: T) => boolean = () => true,
): T {
  const fallback = tabs[0]!;
  const raw = new URLSearchParams(search).get(TAB_PARAM);
  const tab = (tabs as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  return allowed(tab) ? tab : fallback;
}

/** The query string with `tab` written (the default tab = removed); other params kept. */
export function writeTabParam<T extends string>(search: string, tabs: readonly T[], tab: T): string {
  const qs = new URLSearchParams(search);
  if (tab === tabs[0]) qs.delete(TAB_PARAM);
  else qs.set(TAB_PARAM, tab);
  const out = qs.toString();
  return out ? `?${out}` : "";
}
