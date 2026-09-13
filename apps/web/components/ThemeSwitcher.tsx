"use client";

import { THEME_IDS, THEMES, type ThemeId } from "@/lib/themes";

/**
 * The theme switcher.
 *
 * A native select, for the same reason the camera menu is one on a phone: it is
 * the right control on a touch screen and a perfectly good one with a mouse,
 * and it needs no popover the map would have to lay out around. Kiosk mode
 * hides it with the rest of the controls; a wall display pins its theme with
 * `?theme=` and anyone at the keyboard can still walk the set with T.
 *
 * The choice is per viewer (localStorage), never per world: a theme changes how
 * the campus looks to YOU, and nobody else's screen moves when you pick one.
 */
export function ThemeSwitcher({
  value,
  onChange,
  label,
}: {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
  label: string;
}) {
  return (
    <label
      className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/15 bg-dusk-950/80 py-1 pl-4 pr-1 text-xs uppercase tracking-widest text-white/60"
      title={`${THEMES[value].lexicon.blurb} (T cycles themes)`}
    >
      <span className="hidden sm:inline">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ThemeId)}
        aria-label={label}
        className="rounded-full bg-transparent py-2 pl-1 pr-2 text-xs normal-case tracking-normal text-lantern-300 outline-none focus-visible:ring-2 focus-visible:ring-lantern-400 sm:py-1"
      >
        {THEME_IDS.map((id) => (
          <option key={id} value={id} className="bg-dusk-950 text-white">
            {THEMES[id].lexicon.name}
          </option>
        ))}
      </select>
    </label>
  );
}
