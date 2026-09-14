import { afterEach, describe, expect, it } from "vitest";
import { checkedKing, fourLastCell } from "../lib/boards";
import { THEME_EVENT, THEME_IDS, THEME_STORAGE_KEY, THEMES, subscribeThemeChoice, writeThemeChoice } from "../lib/themes";
import { aoe, ROOM_STYLE as AOE_ROOM } from "../lib/themes/aoe";
import { city, ROOM_STYLE as CITY_ROOM } from "../lib/themes/city";
import { AGENT_NAME, TABLE_MARKS, WHISPER_RING, roomColours, tableColours, tokenColour } from "../lib/themes/room-palette";
import { ROOM_PIECES, drawRoomPiece, type RoomStyle } from "../lib/themes/room";
import { scifi, ROOM_STYLE as SCIFI_ROOM } from "../lib/themes/scifi";
import { space, ROOM_STYLE as SPACE_ROOM } from "../lib/themes/space";
import { HAZARD_COLOUR, type Ctx } from "../lib/themes/types";

function recordingCtx() {
  const inks: string[] = [];
  let calls = 0;
  const target: Record<string, unknown> = {
    createRadialGradient: () => ({ addColorStop: (_: number, c: string) => inks.push(c.toLowerCase()) }),
  };
  const ctx = new Proxy(target, {
    get(o, k: string) {
      if (k in o) return o[k];
      return () => {
        calls += 1;
      };
    },
    set(o, k: string, v) {
      if ((k === "fillStyle" || k === "strokeStyle") && typeof v === "string") inks.push(v.toLowerCase());
      o[k] = v;
      return true;
    },
  }) as unknown as Ctx;
  return { ctx, inks, calls: () => calls };
}

const hazards = Object.values(HAZARD_COLOUR).map((c) => c.toLowerCase());

describe("pixel room art in every theme (#58)", () => {
  const themes: Array<[string, RoomStyle, { art: { room: unknown } }]> = [
    ["aoe", AOE_ROOM, aoe],
    ["space", SPACE_ROOM, space],
    ["city", CITY_ROOM, city],
    ["scifi", SCIFI_ROOM, scifi],
  ];

  it.each(themes)("%s fills the room slot and draws every piece, never in hazard colours", (_id, style, theme) => {
    expect(typeof theme.art.room).toBe("function");
    for (const piece of ROOM_PIECES) {
      const { ctx, inks, calls } = recordingCtx();
      drawRoomPiece(ctx, piece, style);
      expect(calls()).toBeGreaterThan(0);
      for (const h of hazards) expect(inks).not.toContain(h);
    }
  });

  it("each theme picks its own material and floor", () => {
    const styles = themes.map(([, s]) => s);
    expect(new Set(styles.map((s) => s.material)).size).toBe(4);
    expect(new Set(styles.map((s) => s.floor)).size).toBe(4);
  });
});

describe("room drawer palette mapping (#58)", () => {
  it("formats chrome triplets as CSS colours", () => {
    expect(tokenColour("7 8 20")).toBe("rgb(7 8 20)");
    expect(tokenColour("7 8 20", 0.5)).toBe("rgb(7 8 20 / 0.5)");
  });

  it.each(THEME_IDS)("%s: the room and the board take the theme's own tokens", (id) => {
    const { palette } = THEMES[id];
    const room = roomColours(palette);
    const table = tableColours(palette);
    expect(room.humanName).toBe(tokenColour(palette.chrome.lantern300));
    expect(room.dim).toBe(tokenColour(palette.chrome.dusk950, 0.45));
    expect(table.firstDisc).toBe(tokenColour(palette.chrome.lantern400));
    expect(table.darkSquare).toBe(tokenColour(palette.chrome.dusk700));
    expect(table.frame).toBe(tokenColour(palette.chrome.dusk700, 0.85));
    // Human and agent stay distinguishable; the whisper ring is the whisper violet.
    expect(room.agentName).toBe(AGENT_NAME);
    expect(room.humanName).not.toBe(room.agentName);
    expect(room.whisperRing).toBe(WHISPER_RING);
    // Seat 0 and seat 1, white and black, never share a colour.
    expect(table.firstDisc).not.toBe(table.secondDiscRing);
    expect(table.whitePiece).not.toBe(table.blackPiece);
    expect(table.lightSquare).not.toBe(table.darkSquare);
  });

  it("follows the theme: the four boards are not one board", () => {
    expect(new Set(THEME_IDS.map((id) => tableColours(THEMES[id].palette).firstDisc)).size).toBe(4);
    expect(new Set(THEME_IDS.map((id) => roomColours(THEMES[id].palette).humanName)).size).toBe(4);
  });

  it("keeps the game marks theme-invariant and out of every palette and hazard colour", () => {
    const marks = Object.values(TABLE_MARKS).map((c) => c.toLowerCase());
    for (const id of THEME_IDS) {
      const inks = Object.values(tableColours(THEMES[id].palette)).map((c) => c.toLowerCase());
      for (const m of marks) expect(inks).not.toContain(m);
    }
    for (const h of hazards) expect(marks).not.toContain(h);
    expect(marks).not.toContain(WHISPER_RING.toLowerCase());
  });
});

describe("board marks (#58)", () => {
  it("finds the last disc dropped, in fourRows order", () => {
    const grid = "x" + ".".repeat(6) + "o" + ".".repeat(34); // x at bottom col 0, o on top of it
    expect(fourLastCell({ game: "four", grid }, [{ move: "1" }, { move: "1" }])).toEqual([4, 0]);
    expect(fourLastCell({ game: "four", grid }, [])).toBeNull();
    expect(fourLastCell({ game: "four", grid }, [{ move: "7" }])).toBeNull();
    expect(fourLastCell({ game: "chess", fen: "8/8/8/8/8/8/8/8 w - - 0 1" } as never, [{ move: "1" }])).toBeNull();
  });

  it("rings the king of the side to move only while in check", () => {
    expect(checkedKing({ game: "chess", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", history: [] })).toBeNull();
    // Fool's mate position: white king on e1 in check from the queen on h4.
    expect(checkedKing({ game: "chess", fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", history: [] })).toBe("e1");
    expect(checkedKing(null)).toBeNull();
  });
});

describe("the drawer follows the live theme switch (#58)", () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });

  function fakeWindow() {
    const target = new EventTarget();
    const store = new Map<string, string>();
    Object.assign(target, {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      location: { search: "" },
    });
    g.window = target;
    return { target, store };
  }

  it("a switch in this tab reaches a subscriber with the new id", () => {
    const { store } = fakeWindow();
    const heard: string[] = [];
    const off = subscribeThemeChoice((id) => heard.push(id));
    writeThemeChoice("scifi");
    expect(store.get(THEME_STORAGE_KEY)).toBe("scifi");
    expect(heard).toEqual(["scifi"]);
    off();
    writeThemeChoice("city");
    expect(heard).toEqual(["scifi"]);
  });

  it("ignores an unknown id on the event", () => {
    const { target } = fakeWindow();
    const heard: string[] = [];
    const off = subscribeThemeChoice((id) => heard.push(id));
    target.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: "throne" }));
    expect(heard).toEqual([]);
    off();
  });

  it("writing without a window does not throw", () => {
    expect(() => writeThemeChoice("space")).not.toThrow();
  });
});
