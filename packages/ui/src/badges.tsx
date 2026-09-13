import type { CSSProperties } from "react";
import type { PermissionBadge } from "@grove/protocol";
import {
  BADGE_CONSEQUENCE,
  BADGE_LABEL,
  consequenceOf,
  speechState,
  type SpeechState,
} from "./consequences";

/**
 * The sentence is the payload, so it must READ as one wherever it lands. The
 * host app styles `.grove-badge` and `.grove-kind` in its own stylesheet but has
 * no rule for `.grove-consequence`, and this package is outside its Tailwind
 * content globs — so the one line §5.5 is actually about would render as raw
 * body text. An inline style is the only way this package can guarantee its own
 * legibility; the class stays so a host CAN override it.
 */
export const CONSEQUENCE_STYLE: CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.75,
};

const GLYPH: Record<PermissionBadge, string> = {
  listen_only: "ear",
  lurk: "eye",
  speaks_to_agents: "mouth",
  speaks_to_humans: "mouth",
  silent_to_humans: "muted",
  silent_to_agents: "muted",
  unclaimed: "·",
};

/**
 * Presentational only — every input arrives as a prop.
 *
 * `silencedBySpace` is the caller's answer to "is the thing stopping them the
 * room they are standing in?". It cannot be derived from `badges`, which are
 * computed from the actor's own matrix alone.
 */
export function BadgeRow({
  badges,
  silencedBySpace,
  showConsequence = true,
}: {
  badges: PermissionBadge[];
  silencedBySpace?: boolean;
  showConsequence?: boolean;
}) {
  const line = consequenceOf(badges, { silencedBySpace });
  const state: SpeechState | null = speechState(badges, { silencedBySpace });
  return (
    <span className="grove-badges">
      {silencedBySpace ? (
        <span
          className="grove-badge grove-badge-silenced_by_space"
          title={line ?? undefined}
        >
          muted here
        </span>
      ) : null}
      {badges.map((b) => (
        <span key={b} className={`grove-badge grove-badge-${b}`} title={BADGE_CONSEQUENCE[b]}>
          {GLYPH[b]} {BADGE_LABEL[b]}
        </span>
      ))}
      {showConsequence && line ? (
        <span className={`grove-consequence grove-consequence-${state}`} style={CONSEQUENCE_STYLE}>
          {line}
        </span>
      ) : null}
    </span>
  );
}

/** The sentence on its own, for surfaces with no room for chips. */
export function ConsequenceLine({
  badges,
  silencedBySpace,
  withRecourse = false,
}: {
  badges?: PermissionBadge[];
  silencedBySpace?: boolean;
  withRecourse?: boolean;
}) {
  const line = consequenceOf(badges, { silencedBySpace, withRecourse });
  if (!line) return null;
  const state = speechState(badges, { silencedBySpace });
  return (
    <span className={`grove-consequence grove-consequence-${state}`} style={CONSEQUENCE_STYLE}>
      {line}
    </span>
  );
}
