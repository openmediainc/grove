"use client";

import { useEffect, useState } from "react";
import { REACTION_GLYPH, REACTION_KEYS, REACTION_LABEL, type ReactionKey } from "@grove/protocol";
import { api } from "@/lib/api";
import { GUEST_EVENT } from "@/lib/guest";
import {
  applyReaction,
  reactionChips,
  reactionRefusalText,
  type ReactionSummaryWire,
  type ReactionTargetWire,
} from "@/lib/reactions";

/**
 * The reaction row under a line or a chronicle event: the counts it already
 * has, and a small palette to add one. Every send goes to POST
 * /api/v1/reactions, where the permission kernel judges it like speech; the
 * click is optimistic and is put back if the server refuses.
 *
 * `canReact` false shows the counts and no controls. `asGuest` (signed out)
 * still reacts — the server gives this browser a guest pass on the first one —
 * and says so, quietly, beside the palette.
 */
export function Reactions({
  target,
  summary,
  canReact,
  asGuest = false,
  onChange,
}: {
  target: ReactionTargetWire;
  summary: ReactionSummaryWire | null | undefined;
  canReact: boolean;
  asGuest?: boolean;
  onChange?: (next: ReactionSummaryWire) => void;
}) {
  const [state, setState] = useState<ReactionSummaryWire | null | undefined>(summary);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setState(summary), [summary]);

  const chips = reactionChips(state);
  if (!canReact && chips.length === 0) return null;

  async function toggle(key: ReactionKey, on: boolean) {
    if (!canReact || busy) return;
    const before = state;
    setState(applyReaction(before, key, on));
    setOpen(false);
    setNote(null);
    setBusy(true);
    try {
      const r = await api<{ reaction: { summary: ReactionSummaryWire } }>("/api/v1/reactions", {
        method: "POST",
        body: JSON.stringify({ target_kind: target.kind, target_id: target.id, emoji: key, on }),
      });
      setState(r.reaction.summary);
      onChange?.(r.reaction.summary);
      if (asGuest) window.dispatchEvent(new Event(GUEST_EVENT));
    } catch (e) {
      setState(before);
      setNote(reactionRefusalText((e as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          disabled={!canReact || busy}
          onClick={() => void toggle(c.key, !c.mine)}
          aria-pressed={c.mine}
          title={c.mine ? `Remove your ${c.label}` : c.label}
          className={`rounded-full border px-1.5 py-px tabular-nums ${
            c.mine ? "border-lantern-400/60 bg-lantern-400/10 text-lantern-300" : "border-white/10 text-white/60"
          } disabled:cursor-default`}
        >
          <span aria-hidden>{c.glyph}</span>
          <span className="sr-only">{c.label}</span> {c.count}
        </button>
      ))}
      {canReact ? (
        <span className="relative">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label="Add a reaction"
            className="rounded-full border border-white/10 px-1.5 py-px text-white/35 hover:text-white/70"
          >
            +
          </button>
          {open ? (
            <span
              role="menu"
              className="absolute left-0 top-full z-20 mt-1 flex gap-0.5 rounded-full border border-white/15 bg-dusk-900 px-1 py-0.5 shadow-lg"
            >
              {REACTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  title={REACTION_LABEL[key]}
                  aria-label={REACTION_LABEL[key]}
                  onClick={() => void toggle(key, true)}
                  className="rounded-full px-1 text-sm hover:bg-white/10"
                >
                  {REACTION_GLYPH[key]}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {canReact && asGuest && (open || (state?.mine.length ?? 0) > 0) ? (
        <span className="text-white/30" title="Signed out: kept in this browser. Sign in and it moves to your account.">
          as a guest
        </span>
      ) : null}
      {note ? <span className="text-white/40">{note}</span> : null}
    </span>
  );
}
