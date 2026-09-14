import { describe, expect, it } from "vitest";
import { MODE_STORAGE_KEY, NO_FLASH_SCRIPT, applyModeChoice, readModeChoice, resolveMode } from "../tokens/index.js";

describe("mode resolution", () => {
  it("follows the system when nothing is stored", () => {
    expect(resolveMode({})).toBe("light");
    expect(resolveMode({ systemDark: false })).toBe("light");
    expect(resolveMode({ systemDark: true })).toBe("night");
  });

  it("a stored choice beats the system", () => {
    expect(resolveMode({ stored: "light", systemDark: true })).toBe("light");
    expect(resolveMode({ stored: "night", systemDark: false })).toBe("night");
    expect(resolveMode({ stored: "tv" })).toBe("tv");
  });

  it("ignores junk in storage", () => {
    expect(resolveMode({ stored: "dark", systemDark: true })).toBe("night");
    expect(resolveMode({ stored: "", systemDark: false })).toBe("light");
    expect(resolveMode({ stored: null })).toBe("light");
  });

  it("TV/kiosk always resolves to tv", () => {
    expect(resolveMode({ tv: true, stored: "light", systemDark: false })).toBe("tv");
  });

  function fakeDoc(search = "", stored: string | null = null, throwing = false) {
    const attrs = new Map<string, string>();
    const storage = new Map<string, string>(stored ? [[MODE_STORAGE_KEY, stored]] : []);
    const documentElement = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    };
    const localStorage = {
      getItem: (k: string) => {
        if (throwing) throw new Error("SecurityError");
        return storage.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (throwing) throw new Error("SecurityError");
        storage.set(k, v);
      },
      removeItem: (k: string) => storage.delete(k),
    };
    return { attrs, storage, documentElement, localStorage, location: { search } };
  }

  function runScript(env: ReturnType<typeof fakeDoc>) {
    new Function("document", "localStorage", "location", NO_FLASH_SCRIPT)(
      { documentElement: env.documentElement },
      env.localStorage,
      env.location,
    );
  }

  it("the no-flash script sets data-mode from storage or ?tv=1, and nothing otherwise", () => {
    const none = fakeDoc();
    runScript(none);
    expect(none.attrs.has("data-mode")).toBe(false);

    const stored = fakeDoc("", "night");
    runScript(stored);
    expect(stored.attrs.get("data-mode")).toBe("night");

    const tv = fakeDoc("?x=1&tv=1", "light");
    runScript(tv);
    expect(tv.attrs.get("data-mode")).toBe("tv");

    const junk = fakeDoc("?tv=10", "sepia");
    runScript(junk);
    expect(junk.attrs.has("data-mode")).toBe(false);
  });

  it("the no-flash script never throws when storage is blocked", () => {
    const blocked = fakeDoc("", "night", true);
    expect(() => runScript(blocked)).not.toThrow();
    expect(blocked.attrs.has("data-mode")).toBe(false);
  });

  it("applyModeChoice stores and sets, and system clears both", () => {
    const env = fakeDoc();
    const doc = { documentElement: env.documentElement } as unknown as Document;
    applyModeChoice("tv", doc, env.localStorage as unknown as Storage);
    expect(env.attrs.get("data-mode")).toBe("tv");
    expect(env.storage.get(MODE_STORAGE_KEY)).toBe("tv");
    applyModeChoice("system", doc, env.localStorage as unknown as Storage);
    expect(env.attrs.has("data-mode")).toBe(false);
    expect(env.storage.has(MODE_STORAGE_KEY)).toBe(false);
  });

  it("applyModeChoice still applies when storage throws", () => {
    const env = fakeDoc("", null, true);
    const doc = { documentElement: env.documentElement } as unknown as Document;
    expect(() => applyModeChoice("night", doc, env.localStorage as unknown as Storage)).not.toThrow();
    expect(env.attrs.get("data-mode")).toBe("night");
  });

  it("readModeChoice answers the stored mode, else system, and never throws", () => {
    expect(readModeChoice(fakeDoc("", "night").localStorage)).toBe("night");
    expect(readModeChoice(fakeDoc("", "light").localStorage)).toBe("light");
    expect(readModeChoice(fakeDoc().localStorage)).toBe("system");
    expect(readModeChoice(fakeDoc("", "sepia").localStorage)).toBe("system");
    expect(readModeChoice(fakeDoc("", "night", true).localStorage)).toBe("system");
  });
});
