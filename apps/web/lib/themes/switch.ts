/**
 * How the map moves from one theme to another when the next one may not be
 * downloaded yet (#79). Three things, which can briefly disagree:
 *
 *   chosen — what the viewer picked (or the resolution order landed on). The
 *            switcher's check follows it at once.
 *   words  — the loaded theme whose in-world names are in use. Follows chosen
 *            once its module has arrived.
 *   drawn  — the theme the canvas draws. Follows once its art is prepared as
 *            well, so a switch never paints a frame of missing sprites.
 *
 * While a theme is loading, the map keeps words and art of the theme it had
 * (aoe on a first visit, which is bundled). A later choice wins over an earlier
 * one still in flight. A failed load leaves the screen as it was and moves
 * `chosen` back to it.
 */

import type { Theme, ThemeId } from "./types";

export type ThemeSwitch = {
  readonly chosen: ThemeId;
  readonly words: Theme;
  readonly drawn: Theme;
  /** Resolves once the choice has settled (drawn, superseded, or failed). Never rejects. */
  choose(id: ThemeId): Promise<void>;
};

export function createThemeSwitch(opts: {
  initial: Theme;
  load: (id: ThemeId) => Promise<Theme>;
  onChosen?: (id: ThemeId) => void;
  onWords?: (theme: Theme) => void;
  onDrawn?: (theme: Theme) => void;
  onFailed?: (id: ThemeId, error: unknown) => void;
}): ThemeSwitch {
  let chosen: ThemeId = opts.initial.id;
  let words: Theme = opts.initial;
  let drawn: Theme = opts.initial;

  const choose = async (id: ThemeId): Promise<void> => {
    chosen = id;
    opts.onChosen?.(id);
    let next: Theme;
    try {
      next = await opts.load(id);
    } catch (err) {
      opts.onFailed?.(id, err);
      if (chosen === id) {
        chosen = words.id;
        opts.onChosen?.(chosen);
      }
      return;
    }
    if (chosen !== id) return;
    words = next;
    opts.onWords?.(next);
    try {
      await next.art.prepare();
    } catch {
      /* the art treats a missing image as "not yet"; draw what there is */
    }
    if (chosen !== id) return;
    drawn = next;
    opts.onDrawn?.(next);
  };

  return {
    get chosen() {
      return chosen;
    },
    get words() {
      return words;
    },
    get drawn() {
      return drawn;
    },
    choose,
  };
}
