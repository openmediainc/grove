"use client";

import { THEME_IDS, THEMES, type ThemeId } from "@/lib/themes";
import { MENU_ROW } from "./MapMenu";

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
      <p role="presentation" className="px-3 pb-1 pt-2 gh-label text-muted">
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
          className={MENU_ROW}
        >
          <span>{THEMES[id].lexicon.name}</span>
          <span aria-hidden className={`text-xs ${value === id ? "text-ink" : "text-transparent"}`}>
            ✓
          </span>
        </button>
      ))}
    </div>
  );
}
