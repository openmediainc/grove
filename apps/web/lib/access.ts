/**
 * One access vocabulary on every page (DECISIONS #3): Open · Watch only ·
 * Private. The preset names (`public_write`, `public_view`, `private`) are the
 * wire contract and never appear on their own in the UI.
 *
 * Pure, so every page that names a space's (or a room's) access uses the same
 * word, the same one-line explanation and the same tint.
 */

/** Mirrors SpacePolicyPreset in @grove/protocol; the API validates the real thing. */
export type SpacePolicyPreset = "private" | "public_view" | "public_write";

export type AccessWord = "Open" | "Watch only" | "Private";

export type AccessCopy = { word: AccessWord; line: string };

export const ACCESS: Record<SpacePolicyPreset, AccessCopy> = {
  public_write: { word: "Open", line: "Anyone can come in, listen and speak." },
  public_view: { word: "Watch only", line: "Anyone can come in and listen; only members speak." },
  private: { word: "Private", line: "Members only. Outsiders see a held plot with no name." },
};

/** Open first, closed last: the same reading order as the map's tints. */
export const ACCESS_ORDER: SpacePolicyPreset[] = ["public_write", "public_view", "private"];

export function isPreset(v: unknown): v is SpacePolicyPreset {
  return v === "public_write" || v === "public_view" || v === "private";
}

/** An unknown preset reads as Private: privacy wins ties. */
export function accessCopy(preset: string | null | undefined): AccessCopy {
  return isPreset(preset) ? ACCESS[preset] : ACCESS.private;
}

export function accessWord(preset: string | null | undefined): AccessWord {
  return accessCopy(preset).word;
}

/** Tint per access level. Open is warm, closed is cold. */
export function accessTint(preset: string | null | undefined): string {
  if (preset === "public_write") return "border-lantern-400/40 text-lantern-300";
  if (preset === "public_view") return "border-sky-400/30 text-sky-200";
  return "border-white/15 text-white/50";
}

/**
 * A room's door, relative to its space. `null` follows the space; any preset
 * replaces it (a lobby on a private plot, or a closed room in an open space).
 */
export const ROOM_DOOR_CHOICES: Array<{ key: string; value: SpacePolicyPreset | null; label: string }> = [
  { key: "inherit", value: null, label: "Same as the space" },
  { key: "public_write", value: "public_write", label: "Open: visitors come in and speak" },
  { key: "public_view", value: "public_view", label: "Watch only: visitors come in and listen" },
  { key: "private", value: "private", label: "Private: members only" },
];

export function roomDoorWord(roomPreset: string | null, spacePreset: string): AccessWord {
  return accessWord(roomPreset ?? spacePreset);
}
