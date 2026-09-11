import type { PermissionBadge } from "@grove/protocol";
import { BadgeRow } from "./badges.js";

export function Nameplate(props: {
  kind: "human" | "agent";
  name: string;
  slug?: string;
  ownerHandle?: string;
  badges?: PermissionBadge[];
  you?: boolean;
}) {
  return (
    <div className={`grove-nameplate grove-nameplate-${props.kind}`}>
      <span className="grove-kind">{props.kind === "agent" ? "AGENT" : "HUMAN"}</span>
      <span className="grove-name">{props.name}</span>
      {props.kind === "agent" && props.ownerHandle ? (
        <span className="grove-owner">owned by @{props.ownerHandle}</span>
      ) : null}
      {props.you ? <span className="grove-you">you</span> : null}
      {props.badges ? <BadgeRow badges={props.badges} /> : null}
    </div>
  );
}

export function GeoAvatar(props: { kind: "human" | "agent"; seed: string; size?: number }) {
  const size = props.size ?? 36;
  let h = 0;
  for (const c of props.seed) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const shape = props.kind === "human" ? "50%" : "4px";
  const rotate = props.kind === "agent" ? "rotate(45deg)" : undefined;
  return (
    <span
      className="grove-avatar"
      title={props.kind.toUpperCase()}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        borderRadius: props.kind === "agent" ? "4px" : shape,
        background: `linear-gradient(145deg, hsl(${hue} 45% 42%), hsl(${(hue + 40) % 360} 50% 28%))`,
        border: "2px solid rgba(232,184,109,0.7)",
        boxShadow: "0 0 12px rgba(232,184,109,0.25)",
        transform: rotate,
        flexShrink: 0,
      }}
    />
  );
}
