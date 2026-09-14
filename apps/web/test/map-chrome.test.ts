import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLORS, contrast } from "@grove/ui/tokens";
import { IDENTITY_TICK, IDENTITY_TICK_W, drawIdentityTick, identityOf, identityTextClass, identityTickClass } from "@/lib/identity";
import { CHROME_WORDS } from "@/lib/themes/chrome-words";
import { THEME_IDS, THEMES } from "@/lib/themes";
import { tableColours, tokenColour } from "@/lib/themes/room-palette";
import { HAZARD_COLOUR, STALL_RING } from "@/lib/themes/types";
import { VERB_RING } from "@/lib/agent-verbs";
import { isBrandedRoute } from "@/lib/appearance";

const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const src = (p: string) => readFileSync(web(p), "utf8");

/**
 * Map chrome rollout (#74, DECISIONS #7 boundary): brand tokens style the map's
 * chrome; map themes style only the world art and in-world content.
 */

/** Every component that is map chrome and nothing but chrome. */
const CHROME_ONLY = [
  "components/MapMenu.tsx",
  "components/KioskChrome.tsx",
  "components/ArrivalToast.tsx",
  "components/ThemeSwitcher.tsx",
  "components/AttentionBell.tsx",
  "components/ResourceBar.tsx",
  "components/SpectatorPeek.tsx",
  "components/WalkInSheet.tsx",
  "components/SoundControls.tsx",
  "components/HistoryDrawer.tsx",
  "components/ReplayBar.tsx",
  "components/CinemaChrome.tsx",
  "components/RoomDrawer.tsx",
  "components/RoomSignpost.tsx",
  "components/FirstFiveMinutes.tsx",
  "components/RoomPresence.tsx",
  "components/WhisperBar.tsx",
  "components/ReadAloud.tsx",
  "components/StageTrial.tsx",
  "components/Identity.tsx",
  "components/LitMark.tsx",
];

/** Legacy theme-chrome classes: dusk/lantern utilities, raw white ink, the theme display face, ad-hoc palette hues. */
const LEGACY = /(?<![\w-])(?:[a-z-]+:)*(?:(?:bg|text|border|ring|accent|decoration|outline|shadow)-(?:dusk|lantern|violet|amber|sky|rose|emerald|orange|red)-\d{2,3}|(?:bg|text|border|ring)-white(?:\/|\b)|font-display)(?![\w-])/;

function classStrings(code: string): string[] {
  // className="…", className={`…`} and plain string constants holding classes.
  const out: string[] = [];
  for (const m of code.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

describe("map chrome speaks brand tokens (#74)", () => {
  it.each(CHROME_ONLY)("%s has no legacy theme-chrome classes", (file) => {
    const hits = classStrings(src(file)).filter((s) => LEGACY.test(s));
    expect(hits).toEqual([]);
  });

  it("WorldMap's JSX chrome has no legacy classes, and the section no longer carries the theme's chrome tokens", () => {
    const code = src("components/WorldMap.tsx");
    const jsx = code.slice(code.indexOf("  return (\n    <section"));
    expect(classStrings(jsx).filter((s) => LEGACY.test(s))).toEqual([]);
    expect(code).not.toMatch(/themeStyle\(/);
    expect(jsx).toMatch(/className=\{`gh-chrome /);
    expect(jsx).toContain("data-map-chrome");
  });

  it("the room drawer's frame is brand; only the pixel room is wrapped in the theme's tokens", () => {
    const code = src("components/RoomDrawer.tsx");
    const uses = [...code.matchAll(/style=\{themeStyle\(theme\)\}/g)];
    expect(uses).toHaveLength(1);
    const at = uses[0]!.index!;
    // The one themed wrapper is the pixel room's, not the dialog root.
    expect(code.slice(at, at + 200)).toContain("<PixelRoom");
    const root = code.slice(code.indexOf("data-map-drawer"), code.indexOf("<header"));
    expect(root).not.toContain("themeStyle");
    expect(root).toContain("gh-frost");
  });

  it("board pieces stay in-world: on the theme's own ground, in the theme's colours", () => {
    const code = src("components/RoomTables.tsx");
    expect(code).toContain("data-theme-world");
    expect(code).toContain("background: colours.ground");
    for (const id of THEME_IDS) {
      expect(tableColours(THEMES[id].palette).ground).toBe(tokenColour(THEMES[id].palette.chrome.dusk950));
    }
  });

  it("the map route is branded, so its chrome follows the viewer's mode (not the legacy night frame)", () => {
    expect(isBrandedRoute("/")).toBe(true);
    // "/" is the root only; pages joined on their own routes (#75).
    expect(isBrandedRoute("/explore", ["/"])).toBe(false);
  });

  it.each(["components/LeaveMessage.tsx", "components/Reactions.tsx", "components/AgentPrompt.tsx", "components/Activity.tsx"])(
    "shared %s moved to roles with the map",
    (file) => {
      // AgentLinks, in the same file, is page-only (/how-it-works, #75).
      const code = file.endsWith("AgentPrompt.tsx") ? src(file).split("export function AgentLinks")[0]! : src(file);
      expect(classStrings(code).filter((s) => LEGACY.test(s))).toEqual([]);
    },
  );
});

describe("chrome words are plain in every theme (#74)", () => {
  it("uses the house verbs and access words, not a theme's flavour", () => {
    expect(CHROME_WORDS.card.walkOver).toBe("Visit");
    expect(CHROME_WORDS.card.follow).toBe("Follow");
    expect(CHROME_WORDS.card.message).toBe("Message");
    expect(CHROME_WORDS.access.public_write.label).toBe("open");
    expect(CHROME_WORDS.access.public_view.label).toBe("watch only");
    expect(CHROME_WORDS.access.private.label).toBe("private");
    const flavour = THEME_IDS.filter((id) => id !== "aoe").flatMap((id) => [
      THEMES[id].lexicon.controls.goTo,
      THEMES[id].lexicon.hud.hereNow,
      THEMES[id].lexicon.card.walkOver,
      THEMES[id].lexicon.aHuman,
    ]);
    const words = JSON.stringify(CHROME_WORDS);
    for (const w of flavour) {
      if (w === CHROME_WORDS.controls.goTo || w === CHROME_WORDS.hud.hereNow || w === "Visit" || w === "A person") continue;
      expect(words, w).not.toContain(`"${w}"`);
    }
  });

  it("the map chrome reads its words from CHROME_WORDS, and the theme lexicon only for in-world names", () => {
    const code = src("components/WorldMap.tsx");
    for (const key of ["hud", "controls", "bell", "card", "legend", "postcard.button"]) {
      expect(code, key).not.toContain(`lex.${key}`);
    }
    expect(code).toContain("lex.regions");
  });
});

describe("identity ticks: human amber, agent cyan (#74)", () => {
  it("a person is human; everything else that walks is an agent (Paperclip included)", () => {
    expect(identityOf("human")).toBe("human");
    expect(identityOf("agent")).toBe("agent");
    expect(identityOf("paperclip")).toBe("agent");
    expect(identityOf(undefined)).toBe("agent");
  });

  it("the canvas tick is the night brand pair on a dark backing, readable on any theme ground", () => {
    expect(IDENTITY_TICK.human).toBe(COLORS.night.human);
    expect(IDENTITY_TICK.agent).toBe(COLORS.night.agent);
    expect(IDENTITY_TICK_W).toBeGreaterThan(0);
    // The marks clear 3:1 against the backing itself (night glass).
    expect(contrast(IDENTITY_TICK.human, COLORS.night.ground)).toBeGreaterThanOrEqual(3);
    expect(contrast(IDENTITY_TICK.agent, COLORS.night.ground)).toBeGreaterThanOrEqual(3);
  });

  it("never borrows a hazard, stall or verb colour", () => {
    const reserved = [...Object.values(HAZARD_COLOUR), STALL_RING, ...Object.values(VERB_RING)].map((c) => c.toLowerCase());
    for (const c of [IDENTITY_TICK.human, IDENTITY_TICK.agent]) expect(reserved).not.toContain(c.toLowerCase());
  });

  it("draws a backing and a kind-shaped mark in the identity colour", () => {
    for (const kind of ["human", "agent"] as const) {
      const fills: string[] = [];
      const ops: string[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get(o, k: string) {
          if (k in o) return o[k];
          return () => ops.push(k);
        },
        set(o, k: string, v) {
          if (k === "fillStyle") fills.push(String(v));
          o[k] = v;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
      drawIdentityTick(ctx, 10, 10, kind);
      expect(fills).toEqual([IDENTITY_TICK.backing, IDENTITY_TICK[kind]]);
      expect(ops.includes("lineTo")).toBe(kind === "agent");
      expect(ops[0]).toBe("save");
      expect(ops[ops.length - 1]).toBe("restore");
    }
  });

  it("chrome ticks use the brand tokens (day-safe by day, Nightwatch by night) and differ by shape", () => {
    expect(identityTickClass("human")).toContain("bg-human");
    expect(identityTickClass("agent")).toContain("bg-agent");
    expect(identityTickClass("human")).toContain("rounded-full");
    expect(identityTickClass("agent")).toContain("rotate-45");
    expect(identityTextClass("human")).toBe("text-human");
    expect(identityTextClass("agent")).toBe("text-agent");
    expect(COLORS.light.human).toBe("#8A5200");
    expect(COLORS.light.agent).toBe("#0A6680");
  });

  it("the map's nameplates carry the tick", () => {
    const code = src("components/WorldMap.tsx");
    expect(code).toContain("drawIdentityTick(ctx");
    expect(code).toContain("identity: identityOf(a.kind)");
  });
});
