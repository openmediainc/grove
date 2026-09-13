/**
 * Who said what, and when: the input to speech layout.
 *
 * Bubbles used to be a field on the body (`actor.bubble`) that the map's
 * eight-second poll wiped and re-seeded, so a line said over SSE flickered off
 * at the next poll; and the room page looked up each speaker's OLDEST line in
 * the transcript rather than the newest. One line per speaker, newest wins.
 */

export type Line = { text: string; at: number; whisper: boolean };

/** Longest line kept. The near tier wraps to three lines of ~30 chars. */
export const SPEECH_KEEP_CHARS = 140;

export class SpeechBook {
  private lines = new Map<string, Line>();

  /** A line heard live. Always wins over an older one. */
  hear(actorId: string, text: string, at = Date.now(), whisper = false): void {
    const cur = this.lines.get(actorId);
    if (cur && cur.at > at) return;
    this.lines.set(actorId, { text: text.slice(0, SPEECH_KEEP_CHARS), at, whisper });
  }

  /**
   * Seed from a list of recent lines that carries no timestamps, oldest first.
   * A line already held keeps its time, so re-seeding the same list on every
   * poll does not reshuffle who is "newest" and move bubbles around.
   */
  seed(recent: ReadonlyArray<{ actorId: string; text: string }>, now = Date.now()): void {
    // Only each speaker's LAST line counts; an earlier one applied first would
    // overwrite the held line with a fresher fake time and reorder everyone.
    const lastIdx = new Map<string, number>();
    recent.forEach((r, i) => lastIdx.set(r.actorId, i));
    recent.forEach((r, i) => {
      if (lastIdx.get(r.actorId) !== i) return;
      const text = r.text.slice(0, SPEECH_KEEP_CHARS);
      const cur = this.lines.get(r.actorId);
      if (cur && cur.text === text) return;
      const at = now - 60_000 - (recent.length - 1 - i) * 1000;
      if (cur && cur.at > at) return;
      this.lines.set(r.actorId, { text, at, whisper: false });
    });
  }

  get(actorId: string): Line | undefined {
    return this.lines.get(actorId);
  }

  /** Forget speakers no longer present, and live lines older than `maxAgeMs`. */
  prune(present: ReadonlySet<string>, maxAgeMs: number, now = Date.now()): void {
    for (const [id, l] of this.lines) {
      if (!present.has(id) || now - l.at > maxAgeMs) this.lines.delete(id);
    }
  }
}
