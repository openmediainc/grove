"use client";

import { useEffect, useState } from "react";
import { MODE_EVENT, MODE_STORAGE_KEY, applyModeChoice, readModeChoice, type ModeChoice } from "@grove/ui/tokens";
import { MENU_HEADING_CLASS, menuItemClass } from "@/lib/brand-ui";
import { APPEARANCE_CHOICES, APPEARANCE_LABEL } from "@/lib/appearance";

/**
 * Appearance: System · Light · Night (DECISIONS #7). The choice is per browser
 * (localStorage, via @grove/ui's mode API); System clears it and follows the
 * OS live. Every toggle on the page, and other tabs, stay in step.
 */
export function useModeChoice(): [ModeChoice, (c: ModeChoice) => void] {
  const [choice, setChoice] = useState<ModeChoice>("system");
  useEffect(() => {
    setChoice(readModeChoice());
    const same = (e: Event) => setChoice((e as CustomEvent<ModeChoice>).detail ?? readModeChoice());
    const other = (e: StorageEvent) => {
      if (e.key !== MODE_STORAGE_KEY) return;
      const next = readModeChoice();
      if (next === "system") document.documentElement.removeAttribute("data-mode");
      else document.documentElement.setAttribute("data-mode", next);
      setChoice(next);
    };
    window.addEventListener(MODE_EVENT, same);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(MODE_EVENT, same);
      window.removeEventListener("storage", other);
    };
  }, []);
  return [choice, (c) => applyModeChoice(c)];
}

/**
 * Inside a menu (You, the map's ⋯): menuitemradio rows, so the menu's arrow
 * keys walk them and a screen reader hears which is checked. Picking one keeps
 * the menu open, like the theme rows.
 */
export function AppearanceMenuGroup() {
  const [choice, choose] = useModeChoice();
  return (
    <div role="group" aria-label="Appearance">
      <p role="presentation" className={MENU_HEADING_CLASS}>
        Appearance
      </p>
      {APPEARANCE_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          role="menuitemradio"
          aria-checked={choice === c}
          tabIndex={-1}
          onClick={() => choose(c)}
          className={menuItemClass({ checked: choice === c })}
        >
          {APPEARANCE_LABEL[c]}
          <span aria-hidden className="text-signal-text">
            {choice === c ? "●" : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Outside a menu (the phone disclosure): a radio group, one Tab stop, arrows move. */
export function AppearanceRadios({ className = "" }: { className?: string }) {
  const [choice, choose] = useModeChoice();
  return (
    <fieldset className={`m-0 min-w-0 border-0 p-0 ${className}`}>
      <legend className={`float-left w-full ${MENU_HEADING_CLASS}`}>Appearance</legend>
      <div className="clear-both flex gap-1 px-2 pb-1">
        {APPEARANCE_CHOICES.map((c) => (
          <label
            key={c}
            className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-gh-pill border text-gh-sm has-[:focus-visible]:shadow-gh-ring ${
              choice === c ? "border-line-strong bg-tint font-medium text-ink" : "border-line text-muted"
            }`}
          >
            <input
              type="radio"
              name="gh-appearance"
              value={c}
              checked={choice === c}
              onChange={() => choose(c)}
              className="sr-only"
            />
            {APPEARANCE_LABEL[c]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
