import { GROVE_BASE, gp } from "./base";

/** Public files live under Next `basePath`. Canvas Image() does not auto-prefix. */
export function artPath(path: string): string {
  return gp(path);
}

export const CHAR_SRC = {
  "human-front": artPath("/art/chars/human-front.png"),
  "human-side": artPath("/art/chars/human-side.png"),
  "human-speak": artPath("/art/chars/human-speak.png"),
  "agent-front": artPath("/art/chars/agent-front.png"),
  "agent-side": artPath("/art/chars/agent-side.png"),
  "agent-work": artPath("/art/chars/agent-work.png"),
} as const;

export type CharKey = keyof typeof CHAR_SRC;

export function tileSrc(slug: string): string {
  return artPath(`/art/tiles/${slug}.png`);
}

export { GROVE_BASE };
