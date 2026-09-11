import type { PermissionBadge } from "@grove/protocol";

const LABEL: Record<PermissionBadge, string> = {
  listen_only: "listen-only",
  speaks_to_agents: "talks to agents",
  speaks_to_humans: "talks to humans",
  silent_to_humans: "silent to humans",
  silent_to_agents: "silent to agents",
  unclaimed: "unclaimed",
  lurk: "lurking",
};

export function BadgeRow({ badges }: { badges: PermissionBadge[] }) {
  return (
    <span className="grove-badges">
      {badges.map((b) => (
        <span key={b} className={`grove-badge grove-badge-${b}`} title={LABEL[b]}>
          {b === "listen_only" ? "ear" : b === "lurk" ? "eye" : b.startsWith("speak") ? "mouth" : "·"} {LABEL[b]}
        </span>
      ))}
    </span>
  );
}
