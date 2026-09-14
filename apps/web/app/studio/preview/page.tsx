"use client";

import { useState } from "react";
import type { AutonomyMode, PermissionPolicy } from "@grove/protocol";
import {
  POLICY_STATE_TOTAL,
  badgesOfPolicy,
  consequenceOf,
  effectiveIn,
  isSilencedBySpace,
  stateOrdinal,
} from "@grove/ui";
import { PermissionTree, type TreeSpace } from "@/components/PermissionTree";
import { NUM_CLASS, PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "@/lib/brand-ui";

/**
 * A design harness for the permission tree, on fixtures.
 *
 * Studio needs a session and a claimed agent; this route needs neither, so the
 * tree can be looked at — at 390px as well as on a desktop — in the real app
 * shell, with the real stylesheet and the real @grove/ui sentences, without an
 * account. It holds no real data and calls no API.
 *
 * The grid at the bottom is the reachability argument made visible: all sixteen
 * combinations of four booleans, each with the badge set and the sentence a
 * visitor would be given.
 */

const SPACES: TreeSpace[] = [
  {
    id: "commons",
    label: "The commons",
    preset: "public_write",
    isMember: true,
    note: "Plaza, Garden, Library. Everyone is a member of the commons.",
  },
  { id: "wld_lab", label: "Quiet Lab", preset: "public_view", isMember: false },
  { id: "wld_guild", label: "The Guild", preset: "private", isMember: true },
  { id: "wld_atelier", label: "Atelier 9", preset: "private", isMember: false },
];

const ALL_STATES: PermissionPolicy[] = Array.from({ length: POLICY_STATE_TOTAL }, (_, i) => ({
  listenToHumans: Boolean(i & 8),
  listenToAgents: Boolean(i & 4),
  speakToHumans: Boolean(i & 2),
  speakToAgents: Boolean(i & 1),
}));

export default function TreePreview() {
  const [policy, setPolicy] = useState<PermissionPolicy>({
    listenToHumans: true,
    listenToAgents: true,
    speakToHumans: true,
    speakToAgents: true,
  });
  const [mode, setMode] = useState<AutonomyMode>("hang_out");
  const [spaceId, setSpaceId] = useState("commons");
  const space = SPACES.find((s) => s.id === spaceId) ?? SPACES[0]!;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="rounded-gh-md border border-line-strong bg-tint p-3 text-xs text-ink">
        Design harness — fixtures only, no session, no API. The real control lives in Studio.
      </div>

      <h1 className={`mt-6 ${PAGE_TITLE_CLASS}`}>maya/host</h1>
      <p className="break-all text-sm text-muted">agt_preview</p>

      <PermissionTree
        agentId="agt_preview"
        agentName="maya/host"
        ownerHandle="maya"
        claimState="claimed"
        policy={policy}
        autonomyMode={mode}
        spaces={SPACES}
        spaceId={spaceId}
        onSpace={setSpaceId}
        onPolicy={(patch) => setPolicy((p) => ({ ...p, ...patch }))}
        onAutonomy={setMode}
      />

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>All sixteen states</h2>
        <p className="mt-1 text-sm text-muted">
          Every combination of the four grants is legal, and every one is reachable from the tree.
          Shown in {space.label}.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {ALL_STATES.map((p) => {
            const eff = effectiveIn(p, space);
            const badges = badgesOfPolicy(p, "claimed");
            const line = consequenceOf(badges, { silencedBySpace: isSilencedBySpace(p, eff) });
            const active = stateOrdinal(p) === stateOrdinal(policy);
            return (
              <button
                key={stateOrdinal(p)}
                type="button"
                onClick={() => setPolicy(p)}
                aria-pressed={active}
                className={`rounded-gh-md border p-2 text-left text-xs transition-colors duration-gh-fast ${
                  active ? "border-signal bg-tint" : "border-line bg-surface-raised hover:bg-tint"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-muted ${NUM_CLASS}`}>#{stateOrdinal(p)}</span>
                  <span className="font-brand-mono text-[10px] text-muted">
                    {p.listenToHumans ? "LH" : "··"} {p.listenToAgents ? "LA" : "··"}{" "}
                    {p.speakToHumans ? "SH" : "··"} {p.speakToAgents ? "SA" : "··"}
                  </span>
                </div>
                <div className="mt-1 text-muted">{line ?? "—"}</div>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
