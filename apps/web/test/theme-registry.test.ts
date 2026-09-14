import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, THEME_IDS, THEME_META, getTheme, isThemeLoaded, loadTheme, peekTheme, createThemeRegistry } from "../lib/themes";
import { THEMES } from "../lib/themes/all";
import { approachingOwnerDefault, type ViewPlot } from "../lib/themes/owner-default";
import { createThemeSwitch } from "../lib/themes/switch";
import type { Theme, ThemeId } from "../lib/themes/types";

/** A minimal stand-in theme: only `id` and `art.prepare` matter to the registry and the switch. */
function fake(id: ThemeId, prepare: () => Promise<void> = async () => {}): Theme {
  return { id, art: { prepare } } as unknown as Theme;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("theme registry: the real one (#79)", () => {
  // Order matters: this runs before anything in this file loads a non-default theme.
  it("has only the default here synchronously; others fall back to it until loaded", () => {
    expect(peekTheme(DEFAULT_THEME)).toBe(THEMES.aoe);
    expect(isThemeLoaded("space")).toBe(false);
    expect(peekTheme("city")).toBeUndefined();
    expect(getTheme("scifi")).toBe(THEMES.aoe);
    expect(getTheme("nonsense")).toBe(THEMES.aoe);
  });

  it("fetches each theme module on demand and caches it", async () => {
    const space = await loadTheme("space");
    expect(space).toBe(THEMES.space);
    expect(peekTheme("space")).toBe(THEMES.space);
    expect(getTheme("space")).toBe(THEMES.space);
    expect(await loadTheme("space")).toBe(space);
    for (const id of THEME_IDS) expect((await loadTheme(id)).id).toBe(id);
  });

  it("an unknown id loads the default", async () => {
    expect(await loadTheme("throne")).toBe(THEMES.aoe);
    expect(await loadTheme(null)).toBe(THEMES.aoe);
  });

  it("names and blurbs are known without loading, and match each lexicon", () => {
    expect(THEME_IDS).toEqual(["aoe", "space", "city", "scifi"]);
    for (const id of THEME_IDS) {
      expect(THEMES[id].lexicon.name).toBe(THEME_META[id].name);
      expect(THEMES[id].lexicon.blurb).toBe(THEME_META[id].blurb);
    }
  });
});

describe("createThemeRegistry: caching", () => {
  const loaders = () => {
    const calls: Record<ThemeId, number> = { aoe: 0, space: 0, city: 0, scifi: 0 };
    const make = (id: ThemeId) => async () => {
      calls[id]++;
      return fake(id);
    };
    return { calls, loaders: { aoe: make("aoe"), space: make("space"), city: make("city"), scifi: make("scifi") } };
  };

  it("concurrent loads share one fetch, later loads hit the cache", async () => {
    const { calls, loaders: l } = loaders();
    const reg = createThemeRegistry(l);
    const [a, b] = await Promise.all([reg.loadTheme("city"), reg.loadTheme("city")]);
    expect(a).toBe(b);
    expect(await reg.loadTheme("city")).toBe(a);
    expect(calls.city).toBe(1);
    expect(calls.space).toBe(0);
  });

  it("an eager theme never calls its loader", async () => {
    const { calls, loaders: l } = loaders();
    const aoe = fake("aoe");
    const reg = createThemeRegistry(l, { aoe });
    expect(reg.peekTheme("aoe")).toBe(aoe);
    expect(await reg.loadTheme("aoe")).toBe(aoe);
    expect(calls.aoe).toBe(0);
  });

  it("a failed fetch is not cached: the next ask tries again", async () => {
    let fail = true;
    const scifi = fake("scifi");
    const reg = createThemeRegistry({
      aoe: async () => fake("aoe"),
      space: async () => fake("space"),
      city: async () => fake("city"),
      scifi: async () => {
        if (fail) throw new Error("ChunkLoadError");
        return scifi;
      },
    });
    await expect(reg.loadTheme("scifi")).rejects.toThrow("ChunkLoadError");
    expect(reg.isThemeLoaded("scifi")).toBe(false);
    fail = false;
    expect(await reg.loadTheme("scifi")).toBe(scifi);
  });

  it("preloadTheme fetches and prepares, and swallows failures", async () => {
    const prepare = vi.fn(async () => {});
    const space = fake("space", prepare);
    const reg = createThemeRegistry({
      aoe: async () => fake("aoe"),
      space: async () => space,
      city: async () => {
        throw new Error("offline");
      },
      scifi: async () => fake("scifi"),
    });
    reg.preloadTheme("space");
    expect(() => reg.preloadTheme("city")).not.toThrow();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(reg.peekTheme("space")).toBe(space);
    expect(reg.isThemeLoaded("city")).toBe(false);
  });
});

describe("createThemeSwitch: fallback while loading", () => {
  it("keeps the current theme's words and art until the next one has loaded and prepared", async () => {
    const aoe = fake("aoe");
    const load = deferred<Theme>();
    const prep = deferred<void>();
    const space = fake("space", () => prep.promise);
    const chosen: ThemeId[] = [];
    const sw = createThemeSwitch({ initial: aoe, load: () => load.promise, onChosen: (id) => chosen.push(id) });

    const done = sw.choose("space");
    expect(sw.chosen).toBe("space");
    expect(chosen).toEqual(["space"]);
    expect(sw.words).toBe(aoe);
    expect(sw.drawn).toBe(aoe);

    load.resolve(space);
    await vi.waitFor(() => expect(sw.words).toBe(space));
    expect(sw.drawn).toBe(aoe); // art not prepared yet: no frame of missing sprites

    prep.resolve();
    await done;
    expect(sw.drawn).toBe(space);
  });

  it("a later choice wins over one still in flight", async () => {
    const aoe = fake("aoe");
    const slow = deferred<Theme>();
    const city = fake("city");
    const sw = createThemeSwitch({ initial: aoe, load: (id) => (id === "space" ? slow.promise : Promise.resolve(id === "city" ? city : aoe)) });
    const first = sw.choose("space");
    await sw.choose("city");
    expect(sw.drawn).toBe(city);
    slow.resolve(fake("space"));
    await first;
    expect(sw.chosen).toBe("city");
    expect(sw.words).toBe(city);
    expect(sw.drawn).toBe(city);
  });

  it("a failed load leaves the screen alone and moves the choice back", async () => {
    const aoe = fake("aoe");
    const failed: ThemeId[] = [];
    const chosen: ThemeId[] = [];
    const sw = createThemeSwitch({
      initial: aoe,
      load: async () => {
        throw new Error("ChunkLoadError");
      },
      onChosen: (id) => chosen.push(id),
      onFailed: (id) => failed.push(id),
    });
    await sw.choose("scifi");
    expect(failed).toEqual(["scifi"]);
    expect(chosen).toEqual(["scifi", "aoe"]);
    expect(sw.chosen).toBe("aoe");
    expect(sw.drawn).toBe(aoe);
  });
});

describe("preload triggers", () => {
  const plot = (plotIndex: number, x0: number, preset: string, defaultTheme: string | null): ViewPlot => ({
    plotIndex,
    rect: { x0, y0: 0, x1: x0 + 3, y1: 3 },
    preset,
    defaultTheme,
  });
  const plots = [plot(0, 0, "public_write", "space"), plot(1, 40, "private", "city"), plot(2, 80, "public_view", null)];
  const none = new Map<number, string>();

  it("a plot the camera is closing in on, before the default applies", () => {
    // 3 tiles off plot 0's edge at a middling zoom: not "on" it yet (zoom 0.9, radius 1), but near.
    expect(approachingOwnerDefault({ camera: { tx: 6.5, ty: 1, zoom: 0.7 }, plots, memberDefaults: none, link: null })).toBe("space");
    expect(approachingOwnerDefault({ camera: { tx: 12, ty: 1, zoom: 0.7 }, plots, memberDefaults: none, link: null })).toBeNull();
    expect(approachingOwnerDefault({ camera: { tx: 2, ty: 1, zoom: 0.4 }, plots, memberDefaults: none, link: null })).toBeNull();
  });

  it("the target of a link while the camera is still gliding there", () => {
    const link = { plotIndex: 0, since: 0, reached: false };
    expect(approachingOwnerDefault({ camera: { tx: 80, ty: 1, zoom: 0.3 }, plots, memberDefaults: none, link })).toBe("space");
  });

  it("never a private plot's default from the public payload", () => {
    const cam = { tx: 41, ty: 1, zoom: 1 };
    expect(approachingOwnerDefault({ camera: cam, plots, memberDefaults: none, link: null })).toBeNull();
    expect(approachingOwnerDefault({ camera: cam, plots, memberDefaults: new Map([[1, "scifi"]]), link: null })).toBe("scifi");
  });

  const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
  const src = (p: string) => readFileSync(web(p), "utf8");

  it("the switcher and the Create preview fetch a theme on hover and on focus", () => {
    for (const file of ["components/ThemeSwitcher.tsx", "components/ClaimPreview.tsx"]) {
      const s = src(file);
      expect(s, file).toMatch(/onPointerEnter=\{\(\) => preloadTheme\(id\)\}/);
      expect(s, file).toMatch(/onFocus=\{\(\) => preloadTheme\(id\)\}/);
    }
    expect(src("components/WorldMap.tsx")).toMatch(/approachingOwnerDefault\([\s\S]{0,200}\);\s*if \(soon\) preloadTheme\(soon\)/);
  });

  it("no app code imports a non-default theme module or the eager set", () => {
    const allowed = new Set(["lib/themes/registry.ts", "lib/themes/all.ts", "lib/themes/contract.typetest.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(web(dir))) {
        const rel = join(dir, name);
        if (statSync(web(rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name) && !allowed.has(rel)) {
          const s = src(rel);
          if (/from\s+"(?:@\/lib\/themes\/|\.\.?\/(?:themes\/)?)(space|city|scifi|all)"/.test(s)) offenders.push(relative(".", rel));
        }
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(dir);
    expect(offenders).toEqual([]);
  });
});
