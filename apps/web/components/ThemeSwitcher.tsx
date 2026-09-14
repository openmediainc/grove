"use client";

import { THEME_IDS, THEMES, type ThemeId } from "@/lib/themes";

/**
 * The theme switcher, a group of radio rows in the map's ⋯ menu. Kiosk mode
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
  // Inside the ⋯ menu (#67) the themes are menuitemradio rows, so the arrow
  // keys walk them with the rest of the menu and a screen reader hears which
  // one is checked. Picking one keeps the menu open, like the other toggles.
  return (
    <div role="group" aria-label={label} title="T cycles themes">
      <p role="presentation" className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-white/50">
        {label}
      </p>
      {THEME_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="menuitemradio"
          aria-checked={value === id}
          tabIndex={-1}
          title={THEMES[id].lexicon.blurb}
          onClick={() => onChange(id)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-white/80 hover:bg-white/5 hover:text-lantern-300 sm:py-2"
        >
          <span>{THEMES[id].lexicon.name}</span>
          <span aria-hidden className={`text-xs ${value === id ? "text-lantern-300" : "text-transparent"}`}>
            ✓
          </span>
        </button>
      ))}
    </div>
  );
}
