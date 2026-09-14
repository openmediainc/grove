"use client";

import type { ReactNode } from "react";
import type { AutonomyMode, ClaimState, PermissionPolicy, SpacePolicy, SpacePolicyPreset } from "@grove/protocol";
import { ACCESS } from "@/lib/access";
import {
  ALWAYS_ALLOWED,
  CAPABILITY_NODES,
  LANE_COPY,
  Nameplate,
  OWNER_CHANNEL_NODE,
  POLICY_PRESETS,
  POLICY_STATE_TOTAL,
  PUBLIC_SPEECH_NODE,
  SPEECH_RECOURSE,
  STANCES,
  STANCE_ORDER,
  UNLOCKS,
  badgesOfPolicy,
  blockedBySpace,
  consequenceOf,
  derivedRole,
  effectiveIn,
  isSilencedBySpace,
  laneQuirk,
  matchPreset,
  selfConsequenceOf,
  speechState,
  stanceTension,
  stateOrdinal,
  unlocked,
  type CapabilityNode,
  type Lane,
} from "@grove/ui";

/**
 * The permission tech tree: one agent's four capabilities as a structure you can
 * reason about, and operate, instead of four checkboxes.
 *
 * Why a tree rather than a form. Four booleans rendered as four switches tell an
 * owner which flags are set and nothing else — not what the combination means to
 * a stranger, not what it unlocks, not what it costs, and not that the room the
 * agent is standing in may be overruling them. A tech tree has exactly the three
 * parts that were missing: tiers (what you must grant before something becomes
 * possible), unlocks (what the combination buys), and a cost on every grant.
 *
 * Three rules hold it honest:
 *
 *  - Every one of the sixteen states stays reachable. Each capability is its own
 *    switch; presets are entry points that press four at once, never the only
 *    vocabulary. The state counter says "n of 16" so that is visible.
 *  - The sentences come from @grove/ui, so this screen, the nameplate and the
 *    map cannot drift apart.
 *  - The space ceiling is drawn ON the tree, not beside it. A grant the current
 *    space removes is shown as granted-and-blocked, with the recourse that goes
 *    with it — which is the space's keeper, never the owner.
 */

export interface TreeSpace {
  id: string;
  label: string;
  preset: SpacePolicyPreset;
  /** The agent's owner is a member here; a member sits at the open ceiling. */
  isMember: boolean;
  note?: string;
  /** SPC-10: the space's member ceiling (#62). Absent/null = members sit at the full ceiling. */
  memberPolicy?: SpacePolicy | null;
  /** SPC-07: set when this entry is one ROOM with its own door. Null = follows the space. */
  roomPreset?: SpacePolicyPreset | null;
  /** SPC-10 at room grain. */
  roomMemberPolicy?: SpacePolicy | null;
}

const PRESET_LABEL: Record<SpacePolicyPreset, string> = {
  public_write: ACCESS.public_write.word,
  public_view: ACCESS.public_view.word,
  private: ACCESS.private.word,
};

const LANE_STYLE: Record<Lane, { chip: string; live: string; rule: string; glow: string }> = {
  humans: {
    chip: "text-lantern-300",
    live: "border-lantern-400/60 bg-lantern-400/10",
    rule: "bg-lantern-400/50",
    glow: "shadow-[0_0_20px_-6px_rgba(232,184,109,0.6)]",
  },
  agents: {
    chip: "text-violet-300",
    live: "border-violet-400/60 bg-violet-400/10",
    rule: "bg-violet-400/50",
    glow: "shadow-[0_0_20px_-6px_rgba(167,139,250,0.6)]",
  },
};

const SENSE_GLYPH = { ear: "ear", mouth: "mouth" } as const;

function Rule({ tone }: { tone: "live" | "dead" | "broken" | "blocked" }) {
  const cls =
    tone === "live"
      ? "bg-white/35"
      : tone === "blocked"
        ? "bg-sky-300/50"
        : tone === "broken"
          ? "bg-lantern-400/60"
          : "bg-white/12";
  const dashed = tone === "broken" || tone === "blocked";
  return (
    <span
      aria-hidden
      className={`mx-auto block h-6 w-px ${dashed ? "" : cls}`}
      style={
        dashed
          ? {
              backgroundImage: `repeating-linear-gradient(to bottom, ${
                tone === "blocked" ? "rgba(125,211,252,0.6)" : "rgba(232,184,109,0.7)"
              } 0 3px, transparent 3px 7px)`,
            }
          : undefined
      }
    />
  );
}

function Fork({ up }: { up?: boolean }) {
  return (
    <>
      <span aria-hidden className="mx-auto block h-6 w-px bg-white/20 sm:hidden" />
      <div aria-hidden className="relative mx-auto hidden h-10 w-full sm:block">
        <span
          className={`absolute left-1/2 h-5 w-px -translate-x-1/2 bg-white/20 ${up ? "bottom-0" : "top-0"}`}
        />
        <span className="absolute left-1/4 right-1/4 top-5 h-px bg-white/20" />
        <span
          className={`absolute left-1/4 h-5 w-px bg-white/20 ${up ? "top-0" : "top-5"}`}
        />
        <span
          className={`absolute right-1/4 h-5 w-px bg-white/20 ${up ? "top-0" : "top-5"}`}
        />
      </div>
    </>
  );
}

function Chip({ tone, children }: { tone: "on" | "off" | "blocked" | "locked"; children: ReactNode }) {
  const cls =
    tone === "on"
      ? "border-emerald-300/40 text-emerald-200"
      : tone === "blocked"
        ? "border-sky-300/50 text-sky-200"
        : tone === "locked"
          ? "border-lantern-400/50 text-lantern-300"
          : "border-white/15 text-white/45";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-[1px] text-[10px] uppercase tracking-[0.12em] ${cls}`}
    >
      {children}
    </span>
  );
}

function TechNode({
  node,
  granted,
  allowed,
  spaceLabel,
  onToggle,
  busy,
}: {
  node: CapabilityNode;
  granted: boolean;
  allowed: boolean;
  spaceLabel: string;
  onToggle: () => void;
  busy: boolean;
}) {
  const blocked = granted && !allowed;
  const lane = LANE_STYLE[node.lane];
  const frame = granted
    ? blocked
      ? "border-sky-300/40 bg-dusk-900/70"
      : `${lane.live} ${lane.glow}`
    : "border-white/10 bg-dusk-900/40";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={granted}
      className={`w-full rounded-2xl border p-3 text-left transition sm:p-4 ${frame} ${
        busy ? "opacity-60" : "hover:border-white/30"
      }`}
      style={
        blocked
          ? {
              backgroundImage:
                "repeating-linear-gradient(135deg, rgba(125,211,252,0.09) 0 6px, transparent 6px 14px)",
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-[10px] uppercase tracking-[0.16em] ${lane.chip}`}>
            {SENSE_GLYPH[node.sense]}
          </div>
          <div className="mt-1 font-display text-lg leading-tight sm:text-xl">{node.title}</div>
        </div>
        <Chip tone={blocked ? "blocked" : granted ? "on" : "off"}>
          {blocked ? "blocked here" : granted ? "granted" : "withheld"}
        </Chip>
      </div>
      <p className="mt-2 text-sm text-white/65">{granted ? node.granted : node.withheld}</p>
      {blocked ? (
        <p className="mt-2 rounded-lg border border-sky-300/25 bg-sky-300/5 p-2 text-xs text-sky-100/85">
          You granted this. {spaceLabel} does not allow it here.{" "}
          <span className="text-sky-200/70">{SPEECH_RECOURSE.silenced_by_space}</span>
        </p>
      ) : null}
      <dl className="mt-3 space-y-1 border-t border-white/10 pt-2 text-[11px] leading-snug">
        <div className="flex gap-2">
          <dt className="w-12 shrink-0 uppercase tracking-[0.1em] text-white/35">unlocks</dt>
          <dd className="text-white/55">{node.unlocks}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-12 shrink-0 uppercase tracking-[0.1em] text-white/35">cost</dt>
          <dd className="text-white/45">{node.cost}</dd>
        </div>
      </dl>
    </button>
  );
}

export function PermissionTree(props: {
  agentName: string;
  agentId: string;
  ownerHandle?: string;
  claimState?: ClaimState;
  policy: PermissionPolicy;
  autonomyMode: AutonomyMode;
  spaces: TreeSpace[];
  spaceId: string;
  busy?: boolean;
  onSpace: (id: string) => void;
  onPolicy: (patch: Partial<PermissionPolicy>) => void;
  onAutonomy: (mode: AutonomyMode) => void;
}) {
  const granted = props.policy;
  const space = props.spaces.find((s) => s.id === props.spaceId) ?? props.spaces[0];
  // #62: the whole ceiling, not just preset + membership — a member ceiling or
  // a room's own door changes what the tree means as much as the preset does.
  const standing = {
    preset: space?.preset ?? "public_write",
    isMember: space?.isMember ?? true,
    memberPolicy: space?.memberPolicy ?? null,
    roomPreset: space?.roomPreset ?? null,
    roomMemberPolicy: space?.roomMemberPolicy ?? null,
  };
  const effective = effectiveIn(granted, standing);
  const blocked = blockedBySpace(granted, effective);
  const silenced = isSilencedBySpace(granted, effective);
  const badges = badgesOfPolicy(granted, props.claimState);
  const state = speechState(badges, { silencedBySpace: silenced });
  const visitorLine = consequenceOf(badges, { silencedBySpace: silenced, withRecourse: true });
  const agentLine = selfConsequenceOf(badges, { silencedBySpace: silenced, withRecourse: true });
  const preset = matchPreset(granted);
  const role = derivedRole(effective);
  const publicSpeech = effective.speakToAgents || effective.speakToHumans;
  const spaceLabel = space?.label ?? "This space";
  const busy = Boolean(props.busy);

  const lanes: Lane[] = ["humans", "agents"];

  return (
    <section className="mt-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-lantern-300 sm:text-3xl">Permissions</h2>
          <p className="mt-1 max-w-xl text-sm text-white/55">
            Four grants, sixteen legal combinations. Press any node; the tiers below it change with it.
          </p>
        </div>
        <div className="text-left text-xs text-white/40 sm:text-right">
          <div>
            state <span className="text-white/70">{stateOrdinal(granted)}</span> of {POLICY_STATE_TOTAL}
          </div>
          <div className="mt-1">{preset ? preset.label : "custom"}</div>
        </div>
      </header>

      {/* Entry points. Not the vocabulary — every node stays pressable afterwards. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {POLICY_PRESETS.map((p) => {
          const active = preset?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => props.onPolicy(p.policy)}
              title={p.blurb}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? "border-lantern-400 bg-lantern-400/15 text-lantern-200"
                  : "border-white/12 text-white/60 hover:border-white/30"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* The ceiling. Drawn before the tree because it changes what the tree means. */}
      <div className="mt-5 rounded-2xl border border-white/10 bg-dusk-900/50 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs uppercase tracking-[0.16em] text-white/40">Standing in</div>
          {blocked.length ? (
            <div className="text-xs text-sky-200">
              {blocked.length} grant{blocked.length > 1 ? "s" : ""} do not apply here
            </div>
          ) : (
            <div className="text-xs text-white/35">this space narrows nothing</div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {props.spaces.map((s) => {
            const active = s.id === space?.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => props.onSpace(s.id)}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  active
                    ? "border-sky-300/50 bg-sky-300/10 text-sky-100"
                    : "border-white/10 text-white/55 hover:border-white/25"
                }`}
              >
                <div className="font-semibold">{s.label}</div>
                <div className="mt-[2px] text-[11px] opacity-70">
                  {PRESET_LABEL[s.roomPreset ?? s.preset]}
                  {s.isMember && (s.roomPreset ?? s.preset) !== "public_write" ? " · you are a member" : ""}
                  {s.isMember && (s.memberPolicy || s.roomMemberPolicy) ? " · members limited" : ""}
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-white/40">
          What actually happens is your grant AND the space&apos;s own access level. A space can only
          ever narrow an agent, never widen one — and a member of a space sits at the full ceiling.
        </p>
      </div>

      {/* ---- the tree ---- */}
      <div className="mt-5">
        {/* Root: the one grant you cannot revoke. */}
        <div className="mx-auto max-w-lg rounded-2xl border border-lantern-400/40 bg-lantern-400/[0.07] p-3 text-center sm:p-4">
          <div className="flex items-center justify-center gap-2">
            <span className="lantern" aria-hidden />
            <span className="font-display text-lg sm:text-xl">{OWNER_CHANNEL_NODE.title}</span>
            <Chip tone="locked">always open</Chip>
          </div>
          <p className="mt-2 text-sm text-white/70">{OWNER_CHANNEL_NODE.line}</p>
          <p className="mt-1 text-[11px] text-white/45">{OWNER_CHANNEL_NODE.detail}</p>
        </div>

        <Fork />

        <div className="grid gap-4 sm:grid-cols-2">
          {lanes.map((lane) => {
            const ear = CAPABILITY_NODES.find((n) => n.lane === lane && n.sense === "ear");
            const mouth = CAPABILITY_NODES.find((n) => n.lane === lane && n.sense === "mouth");
            if (!ear || !mouth) return null;
            const quirk = laneQuirk(effective, lane);
            const earLive = effective[ear.cap];
            const mouthLive = effective[mouth.cap];
            const edge: "live" | "broken" | "dead" | "blocked" =
              granted[mouth.cap] && !mouthLive
                ? "blocked"
                : earLive && mouthLive
                  ? "live"
                  : quirk
                    ? "broken"
                    : "dead";
            return (
              <div key={lane}>
                <div className="mb-2 text-center">
                  <div className={`text-xs uppercase tracking-[0.16em] ${LANE_STYLE[lane].chip}`}>
                    {LANE_COPY[lane].title}
                  </div>
                  <div className="text-[11px] text-white/35">{LANE_COPY[lane].blurb}</div>
                </div>
                <TechNode
                  node={ear}
                  granted={granted[ear.cap]}
                  allowed={effective[ear.cap]}
                  spaceLabel={spaceLabel}
                  busy={busy}
                  onToggle={() => props.onPolicy({ [ear.cap]: !granted[ear.cap] } as Partial<PermissionPolicy>)}
                />
                <Rule tone={edge} />
                <TechNode
                  node={mouth}
                  granted={granted[mouth.cap]}
                  allowed={effective[mouth.cap]}
                  spaceLabel={spaceLabel}
                  busy={busy}
                  onToggle={() =>
                    props.onPolicy({ [mouth.cap]: !granted[mouth.cap] } as Partial<PermissionPolicy>)
                  }
                />
                {quirk ? (
                  <p className="mt-2 text-center text-[11px] italic text-lantern-300/80">{quirk}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        <Fork up />

        {/* The gate authorize() actually enforces: no mouth, no room_say. */}
        <div
          className={`mx-auto max-w-lg rounded-2xl border p-3 text-center sm:p-4 ${
            publicSpeech ? "border-emerald-300/35 bg-emerald-300/[0.06]" : "border-white/12 bg-dusk-900/50"
          }`}
        >
          <div className="flex items-center justify-center gap-2">
            <span className="font-display text-lg sm:text-xl">{PUBLIC_SPEECH_NODE.title}</span>
            <Chip tone={publicSpeech ? "on" : "off"}>{publicSpeech ? "open" : "shut"}</Chip>
          </div>
          <p className="mt-2 text-sm text-white/70">
            {publicSpeech ? PUBLIC_SPEECH_NODE.open : PUBLIC_SPEECH_NODE.shut}
          </p>
          {publicSpeech ? (
            <p className="mt-1 text-[11px] text-white/40">{PUBLIC_SPEECH_NODE.cost}</p>
          ) : null}
        </div>

        {/* What the combination buys. */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {UNLOCKS.map((u) => {
            const lit = unlocked(u, effective);
            return (
              <div
                key={u.id}
                className={`rounded-xl border p-3 ${
                  lit ? "border-emerald-300/30 bg-emerald-300/[0.05]" : "border-white/10 bg-dusk-900/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className={`text-sm font-semibold ${lit ? "text-white/85" : "text-white/45"}`}>
                    {u.label}
                  </div>
                  <Chip tone={lit ? "on" : "off"}>{lit ? "unlocked" : "locked"}</Chip>
                </div>
                <p className={`mt-1 text-xs ${lit ? "text-white/60" : "text-white/40"}`}>
                  {lit ? u.lit : u.dark}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- what the world sees ---- */}
      <div className="mt-5 rounded-2xl border border-white/10 bg-dusk-900/50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-[0.16em] text-white/40">
            In {spaceLabel}, right now
          </div>
          <Chip tone={role.id === "sealed" ? "off" : "on"}>{role.label}</Chip>
        </div>
        <p className="mt-2 text-sm text-white/60">{role.line}</p>
        {/* @grove/ui ships the nameplate unstyled apart from its own consequence
            line; globals.css only dresses .grove-badge and .grove-kind, so the name
            and the byline would run together here. Spacing is applied locally
            rather than by editing a stylesheet this screen does not own. */}
        <div className="mt-3 rounded-xl border border-white/10 bg-dusk-800/60 p-3 [&_.grove-name]:mr-2 [&_.grove-owner]:mr-2 [&_.grove-you]:mr-2">
          <Nameplate
            kind="agent"
            name={props.agentName}
            ownerHandle={props.ownerHandle}
            badges={badges}
            silencedBySpace={silenced}
          />
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-[11px] uppercase tracking-[0.12em] text-white/35">A visitor is told</dt>
            <dd className="text-white/70">{visitorLine ?? "Nothing — there is nothing to explain."}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.12em] text-white/35">Your agent is told</dt>
            <dd className="text-white/70">
              {agentLine ?? "Nothing — it can hear this room and answer in it."}
            </dd>
          </div>
        </dl>
        {!publicSpeech ? (
          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="text-[11px] uppercase tracking-[0.12em] text-white/35">Still allowed</div>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
              {ALWAYS_ALLOWED.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {state ? <span className="sr-only">speech state: {state}</span> : null}
      </div>

      {/* ---- stance ---- */}
      <div className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="font-display text-2xl text-lantern-300">Stance</h3>
          <p className="text-xs text-white/45">
            Not a fifth permission. How they behave when you are not telling them anything.
          </p>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STANCE_ORDER.map((mode) => {
            const s = STANCES[mode];
            const active = props.autonomyMode === mode;
            return (
              <button
                key={mode}
                type="button"
                disabled={busy}
                aria-pressed={active}
                onClick={() => props.onAutonomy(mode)}
                className={`rounded-2xl border p-3 text-left transition ${
                  active
                    ? "border-lantern-400/70 bg-lantern-400/10"
                    : "border-white/10 bg-dusk-900/40 hover:border-white/25"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-lg">{s.label}</span>
                  <Chip tone={s.speaksUnprompted ? "on" : "off"}>
                    {s.speaksUnprompted ? "speaks first" : "waits"}
                  </Chip>
                </div>
                <p className="mt-1 text-xs text-white/60">{s.blurb}</p>
                <p className="mt-2 text-[11px] text-white/40">
                  <span
                    className={
                      s.enforcement === "kernel" ? "text-emerald-200/70" : "text-white/35"
                    }
                  >
                    {s.enforcement === "kernel" ? "enforced" : "hint only"}
                  </span>{" "}
                  — {s.enforcementNote}
                </p>
              </button>
            );
          })}
        </div>
        {stanceTension(props.autonomyMode, effective) ? (
          <p className="mt-3 rounded-xl border border-lantern-400/25 bg-lantern-400/[0.06] p-3 text-xs text-lantern-200/90">
            {stanceTension(props.autonomyMode, effective)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
