/** Public path on Tailscale Serve. Keep in sync with `tailscale serve --set-path /grove`. */
export const GROVE_BASE = process.env.NEXT_PUBLIC_GROVE_BASE ?? "/grove";

export function gp(path: string): string {
  if (!path || path.startsWith("http")) return path;
  if (path === GROVE_BASE || path.startsWith(`${GROVE_BASE}/`)) return path;
  return `${GROVE_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
