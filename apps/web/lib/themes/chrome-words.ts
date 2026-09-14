import { aoe } from "./aoe";
import type { ThemeLexicon } from "./types";

/**
 * The words the map's CHROME says, whatever the theme (DECISIONS #7 boundary).
 *
 * A theme's lexicon names things that live IN the world — room names on their
 * signs and on the drawer title, district names, what a resting body's caption
 * says, the postcard's printed greeting. Everything around the world (the HUD
 * line, the controls and menus, the bell, the peek card, the TV caption tag)
 * is brand chrome and speaks one plain vocabulary: Visit · Follow · Message ·
 * Watch; access is Open · Watch only · Private.
 *
 * Built from the default theme's words, which are already the plain ones, with
 * the few that were flavour replaced.
 */
const base = aoe.lexicon;

export const CHROME_WORDS = {
  aHuman: "A person",
  anAgent: "An agent",
  access: base.access,
  accessUnknown: base.accessUnknown,
  bell: { ...base.bell, allBusy: "nothing waiting" },
  hud: base.hud,
  legend: base.legend,
  card: { ...base.card, walkOver: "Visit", message: "Message" },
  controls: base.controls,
  postcard: { button: base.postcard.button, buttonTitle: base.postcard.buttonTitle },
  marks: base.marks,
} as const satisfies Pick<ThemeLexicon, "aHuman" | "anAgent" | "access" | "accessUnknown" | "bell" | "hud" | "legend" | "card" | "controls" | "marks"> & {
  postcard: Pick<ThemeLexicon["postcard"], "button" | "buttonTitle">;
};
