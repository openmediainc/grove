import { describe, expect, it } from "vitest";
import { SPACE_THEME_IDS, plotForIndex } from "@grove/protocol";
import { DEFAULT_THEME, THEME_IDS, resolveThemeId } from "../lib/themes";
import {
  LINK_REACH_MS,
  PLOT_THEME_STAY_ZOOM,
  PLOT_THEME_ZOOM,
  cameraCentredPlot,
  distanceToPlot,
  linkAtTile,
  plotCentreTile,
  plotOwnerDefault,
  viewedOwnerDefault,
  type ViewPlot,
} from "../lib/themes/owner-default";

const plot = (plotIndex: number, preset: string, defaultTheme: string | null): ViewPlot => ({
  plotIndex,
  rect: plotForIndex(plotIndex),
  preset,
  defaultTheme,
});

const PLOTS = [plot(0, "public_write", "space"), plot(1, "public_view", null), plot(2, "private", null), plot(3, "private", "city")];
const at = (p: ViewPlot, zoom = 1.15) => ({ ...plotCentreTile(p.rect), zoom });
const NONE = new Map<number, string>();

describe("theme resolution order (#59)", () => {
  it("a URL pin beats a stored choice beats the owner default beats the house default", () => {
    expect(resolveThemeId({ query: "scifi", stored: "city", ownerDefault: "space" })).toBe("scifi");
    expect(resolveThemeId({ query: null, stored: "city", ownerDefault: "space" })).toBe("city");
    expect(resolveThemeId({ query: null, stored: null, ownerDefault: "space" })).toBe("space");
    expect(resolveThemeId({ query: null, stored: null, ownerDefault: null })).toBe(DEFAULT_THEME);
  });

  it("unknown ids fall through, including a junk owner default", () => {
    expect(resolveThemeId({ query: "nope", stored: "gone", ownerDefault: "city" })).toBe("city");
    expect(resolveThemeId({ query: "nope", stored: null, ownerDefault: "bogus" })).toBe(DEFAULT_THEME);
  });

  it("the protocol's theme ids are the web registry's", () => {
    expect([...SPACE_THEME_IDS].sort()).toEqual([...THEME_IDS].sort());
  });
});

describe("private redaction", () => {
  it("a public plot's default comes from the minimap", () => {
    expect(plotOwnerDefault(PLOTS[0]!, NONE)).toBe("space");
    expect(plotOwnerDefault(PLOTS[1]!, NONE)).toBeNull();
  });

  it("a private plot ignores anything in the public payload and uses only the member list", () => {
    expect(plotOwnerDefault(PLOTS[3]!, NONE)).toBeNull();
    expect(plotOwnerDefault(PLOTS[2]!, NONE)).toBeNull();
    expect(plotOwnerDefault(PLOTS[2]!, new Map([[2, "scifi"]]))).toBe("scifi");
    expect(plotOwnerDefault(PLOTS[2]!, new Map([[2, "junk"]]))).toBeNull();
  });

  it("an outsider centred on a private plot gets no owner default", () => {
    const r = viewedOwnerDefault({ camera: at(PLOTS[3]!), plots: PLOTS, memberDefaults: NONE, link: null, current: null, now: 0 });
    expect(r.plotIndex).toBe(3);
    expect(r.theme).toBeNull();
  });
});

describe("camera-centred detection", () => {
  it("measures distance to a plot footprint, zero inside", () => {
    const r = plotForIndex(0);
    expect(distanceToPlot(r.x0, r.y0, r)).toBe(0);
    expect(distanceToPlot(r.x1 + 2.5, r.y0, r)).toBeCloseTo(2);
  });

  it("picks the plot under the centre at plot-level zoom only", () => {
    expect(cameraCentredPlot(at(PLOTS[0]!), PLOTS)?.plotIndex).toBe(0);
    expect(cameraCentredPlot(at(PLOTS[0]!, PLOT_THEME_ZOOM - 0.05), PLOTS)).toBeNull();
    expect(cameraCentredPlot({ tx: -500, ty: -500, zoom: 2 }, PLOTS)).toBeNull();
  });

  it("keeps the current plot with a little slack on zoom and edge", () => {
    const r = PLOTS[0]!.rect;
    expect(cameraCentredPlot({ ...at(PLOTS[0]!), zoom: PLOT_THEME_STAY_ZOOM + 0.01 }, PLOTS, 0)?.plotIndex).toBe(0);
    expect(cameraCentredPlot({ ...at(PLOTS[0]!), zoom: PLOT_THEME_STAY_ZOOM + 0.01 }, PLOTS, null)).toBeNull();
    // Just past the edge into empty land: still on plot 0 while current.
    const outside = { tx: r.x0 - 1.8, ty: (r.y0 + r.y1) / 2, zoom: 1.2 };
    const other = PLOTS.some((p) => distanceToPlot(outside.tx, outside.ty, p.rect) === 0);
    if (!other) expect(cameraCentredPlot(outside, PLOTS, 0)?.plotIndex).toBe(0);
  });

  it("applies the owner default while centred and drops it when the camera leaves", () => {
    const on = viewedOwnerDefault({ camera: at(PLOTS[0]!), plots: PLOTS, memberDefaults: NONE, link: null, current: null, now: 0 });
    expect(on).toMatchObject({ plotIndex: 0, theme: "space" });
    const off = viewedOwnerDefault({ camera: { tx: -500, ty: -500, zoom: 1.2 }, plots: PLOTS, memberDefaults: NONE, link: null, current: 0, now: 1 });
    expect(off).toEqual({ plotIndex: null, link: null, theme: null });
  });
});

describe("arriving by a link", () => {
  it("holds while the camera travels there, zoom regardless, then is spent once it leaves", () => {
    const link = linkAtTile(plotCentreTile(PLOTS[0]!.rect).tx, plotCentreTile(PLOTS[0]!.rect).ty, PLOTS, 0);
    expect(link).toEqual({ plotIndex: 0, since: 0, reached: false });
    const far = { tx: -500, ty: -500, zoom: 0.5 };
    const travelling = viewedOwnerDefault({ camera: far, plots: PLOTS, memberDefaults: NONE, link, current: null, now: 1000 });
    expect(travelling).toMatchObject({ theme: "space", link: { reached: false } });
    const arrived = viewedOwnerDefault({ camera: at(PLOTS[0]!, 0.5), plots: PLOTS, memberDefaults: NONE, link: travelling.link, current: 0, now: 2000 });
    expect(arrived).toMatchObject({ theme: "space", link: { reached: true } });
    const left = viewedOwnerDefault({ camera: far, plots: PLOTS, memberDefaults: NONE, link: arrived.link, current: 0, now: 3000 });
    expect(left).toEqual({ plotIndex: null, link: null, theme: null });
  });

  it("gives up on a link whose camera never arrives", () => {
    const link = { plotIndex: 0, since: 0, reached: false };
    const r = viewedOwnerDefault({ camera: { tx: -500, ty: -500, zoom: 0.5 }, plots: PLOTS, memberDefaults: NONE, link, current: null, now: LINK_REACH_MS + 1 });
    expect(r.link).toBeNull();
    expect(r.theme).toBeNull();
  });

  it("a link to a private plot shows members their default and outsiders none", () => {
    const link = { plotIndex: 2, since: 0, reached: false };
    const camera = at(PLOTS[2]!);
    expect(viewedOwnerDefault({ camera, plots: PLOTS, memberDefaults: NONE, link, current: null, now: 1 }).theme).toBeNull();
    expect(viewedOwnerDefault({ camera, plots: PLOTS, memberDefaults: new Map([[2, "city"]]), link, current: null, now: 1 }).theme).toBe("city");
  });

  it("no link starts off the plots", () => {
    expect(linkAtTile(-500, -500, PLOTS, 0)).toBeNull();
  });
});

describe("space page Visit link (#59)", async () => {
  const { visitHref } = await import("../lib/visit-link");
  const { parseDeepLink } = await import("../lib/deep-link");
  const { readWorldUrl } = await import("../lib/world-url");

  it("opens the room and lands the camera on the space's plot", () => {
    const href = visitHref("lobby", 4);
    const qs = href.slice(href.indexOf("?"));
    expect(readWorldUrl(qs).room).toBe("lobby");
    const at = parseDeepLink(qs).at!;
    expect(linkAtTile(at.tx, at.ty, [plot(4, "public_write", "city")], 0)?.plotIndex).toBe(4);
  });

  it("is just the room for the civic core", () => {
    expect(visitHref("plaza", null)).toBe("/?room=plaza");
  });
});
