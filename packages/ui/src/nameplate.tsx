import type { PermissionBadge } from "@grove/protocol";
import { BadgeRow, CONSEQUENCE_STYLE } from "./badges";
import { consequenceOf, selfConsequenceOf, speechState } from "./consequences";

/**
 * Presentational only. §5.5: the nameplate is where "why won't it answer me?"
 * gets answered, so it carries a sentence about what this actor will do, not a
 * list of which booleans are false.
 *
 * `silencedBySpace` is a fact about the room the actor is standing in, so it
 * cannot come from `badges`; the caller supplies it.
 */
export function Nameplate(props: {
  kind: "human" | "agent";
  name: string;
  slug?: string;
  ownerHandle?: string;
  badges?: PermissionBadge[];
  you?: boolean;
  silencedBySpace?: boolean;
}) {
  const state = speechState(props.badges, { silencedBySpace: props.silencedBySpace });
  // The owner is the wrong person to send the reader to when the SPACE is the
  // one refusing, so recourse is spelled out rather than implied by the byline.
  //
  // `you` also switches the VOICE. "They can hear you, but cannot reply in
  // public" is nonsense printed on your own row, and it is worse than nonsense
  // sitting above a composer you are about to type into, so your own row gets
  // the first-person sentence and the recourse that goes with it.
  const line = props.you
    ? selfConsequenceOf(props.badges, {
        silencedBySpace: props.silencedBySpace,
        withRecourse: true,
      })
    : consequenceOf(props.badges, {
        silencedBySpace: props.silencedBySpace,
        withRecourse: state === "silenced_by_space" || state === "unclaimed",
      });
  return (
    <div
      className={`grove-nameplate grove-nameplate-${props.kind}`}
      title={line ?? undefined}
    >
      <span className="grove-kind">{props.kind === "agent" ? "AGENT" : "HUMAN"}</span>
      <span className="grove-name">{props.name}</span>
      {props.kind === "agent" && props.ownerHandle ? (
        <span className="grove-owner">owned by @{props.ownerHandle}</span>
      ) : null}
      {props.you ? <span className="grove-you">you</span> : null}
      {props.badges || props.silencedBySpace ? (
        <BadgeRow
          badges={props.badges ?? []}
          silencedBySpace={props.silencedBySpace}
          showConsequence={false}
        />
      ) : null}
      {line ? (
        <span className={`grove-consequence grove-consequence-${state}`} style={CONSEQUENCE_STYLE}>
          {line}
        </span>
      ) : null}
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
