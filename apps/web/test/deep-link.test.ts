import { describe, expect, it } from "vitest";
import { AT_LIMIT, buildDeepLink, deepLinkApplies, parseAt, parseDeepLink, parseFollow } from "../lib/deep-link";

describe("parseFollow", () => {
  it("accepts domain slugs", () => {
    expect(parseFollow("lantern")).toBe("lantern");
    expect(parseFollow("ops-bot_2")).toBe("ops-bot_2");
    expect(parseFollow(" lantern ")).toBe("lantern");
  });
  it("rejects anything that is not a slug", () => {
    expect(parseFollow(null)).toBeNull();
    expect(parseFollow("")).toBeNull();
    expect(parseFollow("-lead")).toBeNull();
    expect(parseFollow("a b")).toBeNull();
    expect(parseFollow("../x")).toBeNull();
    expect(parseFollow("x".repeat(65))).toBeNull();
  });
});

describe("parseAt", () => {
  it("reads two integers", () => {
    expect(parseAt("12,-7")).toEqual({ tx: 12, ty: -7 });
    expect(parseAt(" 3 , 4 ")).toEqual({ tx: 3, ty: 4 });
  });
  it("rejects malformed or absurd coordinates", () => {
    expect(parseAt(null)).toBeNull();
    expect(parseAt("12")).toBeNull();
    expect(parseAt("1.5,2")).toBeNull();
    expect(parseAt("a,b")).toBeNull();
    expect(parseAt("1,2,3")).toBeNull();
    expect(parseAt(`${AT_LIMIT + 1},0`)).toBeNull();
  });
});

describe("parseDeepLink", () => {
  it("reads both parameters", () => {
    expect(parseDeepLink("?follow=lantern&at=4,5")).toEqual({ follow: "lantern", at: { tx: 4, ty: 5 } });
    expect(parseDeepLink("")).toEqual({ follow: null, at: null });
  });
});

describe("deepLinkApplies", () => {
  it("yields to TV but not to plain kiosk mode", () => {
    expect(deepLinkApplies("?follow=x")).toBe(true);
    expect(deepLinkApplies("?kiosk=1&follow=x")).toBe(true);
    expect(deepLinkApplies("?tv=1&follow=x")).toBe(false);
    expect(deepLinkApplies("?tv=0&follow=x")).toBe(true);
  });
});

describe("buildDeepLink", () => {
  it("writes a follow link, dropping modes and older deep links", () => {
    const out = buildDeepLink("https://g.example/?kiosk=1&tv=1&at=1,2&theme=space#x", { follow: "lantern" });
    const u = new URL(out);
    expect(u.searchParams.get("follow")).toBe("lantern");
    expect(u.searchParams.get("theme")).toBe("space");
    expect(u.searchParams.has("kiosk")).toBe(false);
    expect(u.searchParams.has("tv")).toBe(false);
    expect(u.searchParams.has("at")).toBe(false);
    expect(u.hash).toBe("");
  });
  it("writes a readable at link that round-trips", () => {
    const out = buildDeepLink("https://g.example/grove?follow=old", { at: { tx: 10.4, ty: -3 } });
    expect(out).toBe("https://g.example/grove?at=10,-3");
    expect(parseDeepLink(new URL(out).search)).toEqual({ follow: null, at: { tx: 10, ty: -3 } });
  });
});
