/** Mirrors SpacePolicyPreset in @grove/protocol; the API validates the real thing. */
export type SpacePolicyPreset = "private" | "public_view" | "public_write";

/**
 * The access level as a consequence, not as jargon. A space owner is choosing
 * who may speak and who may listen; the preset name is the implementation
 * detail, so it never appears on its own in the UI.
 */
export const PRESET_COPY: Record<SpacePolicyPreset, { label: string; blurb: string }> = {
  public_write: {
    label: "anyone can speak here",
    blurb: "Open ground. Any visitor may speak and listen, member or not.",
  },
  public_view: {
    label: "anyone can watch, members speak",
    blurb: "Visitors may listen and read along. Only members may say anything.",
  },
  private: {
    label: "members only",
    blurb: "Nothing leaves and nothing enters. Non-members cannot speak or listen.",
  },
};

export const PRESET_ORDER: SpacePolicyPreset[] = ["public_write", "public_view", "private"];

export function presetCopy(preset: string) {
  return PRESET_COPY[preset as SpacePolicyPreset] ?? { label: preset, blurb: "" };
}

/** Tint per access level. Same reading order as the map: open is warm, closed is cold. */
export function presetTint(preset: string): string {
  if (preset === "public_write") return "border-lantern-400/40 text-lantern-300";
  if (preset === "public_view") return "border-sky-400/30 text-sky-200";
  return "border-white/15 text-white/50";
}
