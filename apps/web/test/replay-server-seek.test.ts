import { describe, expect, it } from "vitest";
import { ReplayController, SERVER_SEEK_AHEAD_MS } from "@/lib/replay/controller";

/**
 * Deep seek (queue #63): while a day window is still loading, a seek asks the
 * server for the nearest checkpoint and draws from it at once; the full window
 * replaces it when it lands, drawing the same bodies in the same rooms.
 */
const T0 = Date.parse("2026-09-13T00:00:00.000Z");
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The controller cancels animation frames on open; node has none.
const g = globalThis as unknown as Record<string, unknown>;
g.cancelAnimationFrame ??= () => {};
g.requestAnimationFrame ??= () => 0;

const actor = (id: string) => ({ id, kind: "agent", display_name: id, slug: id });
const join = (id: string, who: string, at: number, room: string) => ({
  id,
  type: "actor_joined_room",
  kind: "movement",
  created_at: iso(at),
  actor: actor(who),
  room_id: room,
  room_name: room,
  summary: `${who} walked into ${room}`,
  body: null,
  body_withheld: false,
  detail: {},
});

describe("replay server seek", () => {
  it("draws a deep seek from a checkpoint before the window has loaded, then hands over to the full window", async () => {
    const calls: string[] = [];
    let releaseWindow: (() => void) | null = null;
    const target = T0 + 20 * H + 90_000;
    const fetcher = async <T,>(path: string): Promise<T> => {
      calls.push(path);
      if (path.startsWith("/api/v1/replay/seek")) {
        const at = Date.parse(new URL(`http://x${path}`).searchParams.get("at")!);
        const cpAt = Math.floor(at / 300_000) * 300_000;
        return {
          window: { since: iso(cpAt), until: iso(Math.min(T0 + 24 * H, at + SERVER_SEEK_AHEAD_MS)) },
          checkpoint: { at: iso(cpAt) },
          keyframe: {
            at: iso(cpAt),
            bodies: [{ actor_id: "smith", kind: "agent", display_name: "smith", slug: "smith", room_id: "plaza", room_name: "plaza", since: iso(T0 + H), event_id: "10" }],
          },
          entries: [join("20", "ivy", cpAt + 30_000, "library")],
          trailing: [],
          tool_calls: [],
        } as T;
      }
      // The day window: one page, held back until the test releases it.
      await new Promise<void>((r) => (releaseWindow = r));
      return {
        keyframe: { at: iso(T0), bodies: [] },
        density: { bucket_seconds: 900, buckets: [] },
        entries: [join("10", "smith", T0 + H, "plaza"), join("20", "ivy", Math.floor(target / 300_000) * 300_000 + 30_000, "library")],
        trailing: [],
        tool_calls: [],
        next_cursor: null,
      } as T;
    };
    const c = new ReplayController(() => {}, fetcher);
    const opening = c.open(T0, T0 + 24 * H);
    await sleep(0);
    expect(c.view.loading).toBe(true);
    expect(c.bodiesAt(target)).toEqual([]);

    c.seek(target);
    expect(c.needsServerSeek(target)).toBe(true);
    await sleep(200);
    expect(c.serverSeeks).toBe(1);
    expect(c.view.provisional).toBe(true);
    expect(c.windowStart).toBeLessThanOrEqual(target);
    const early = c.bodiesAt(target).map((b) => [b.id, b.room_id]);
    expect(early).toEqual([
      ["ivy", "library"],
      ["smith", "plaza"],
    ]);

    // A nudge inside what the answer carried needs no second request...
    c.seek(target + 60_000);
    expect(c.needsServerSeek(target + 60_000)).toBe(false);
    // ...a jump further than that does.
    c.seek(target - 6 * H);
    expect(c.needsServerSeek(target - 6 * H)).toBe(true);
    await sleep(200);
    expect(calls.filter((p) => p.startsWith("/api/v1/replay/seek"))).toHaveLength(2);

    releaseWindow!();
    await opening;
    expect(c.view.loading).toBe(false);
    expect(c.view.provisional).toBe(false);
    expect(c.windowStart).toBe(T0);
    expect(c.needsServerSeek(target)).toBe(false);
    expect(c.bodiesAt(target).map((b) => [b.id, b.room_id])).toEqual(early);
  });

  it("never asks the server once the full window is loaded", async () => {
    const calls: string[] = [];
    const fetcher = async <T,>(path: string): Promise<T> => {
      calls.push(path);
      return { keyframe: { at: iso(T0), bodies: [] }, entries: [], trailing: [], tool_calls: [], next_cursor: null } as T;
    };
    const c = new ReplayController(() => {}, fetcher);
    await c.open(T0, T0 + 24 * H);
    c.seek(T0 + 20 * H);
    await sleep(200);
    expect(calls.some((p) => p.startsWith("/api/v1/replay/seek"))).toBe(false);
    expect(c.serverSeeks).toBe(0);
  });
});
