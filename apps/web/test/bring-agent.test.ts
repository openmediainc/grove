import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRING_AGENT_DISMISSED_KEY,
  BRING_AGENT_HOW_HREF,
  BRING_AGENT_LINE,
  bringAgentVisible,
  ownsAnAgent,
  type BringAgentState,
} from "@/lib/bring-agent";
import { readFlag, writeFlag, type FlagStore } from "@/lib/walk-in";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

/** A bare map, nothing closed, session known. Each case changes one thing. */
const base: BringAgentState = { signedIn: false, ownsAgent: null, dismissed: false, drawerOpen: false, panelOpen: false, bare: false };

function memoryStore(): FlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("Bring your agent: who sees the card", () => {
  it("shows for a signed-out visitor", () => {
    expect(bringAgentVisible(base)).toBe(true);
  });

  it("stays hidden once dismissed, signed in or out", () => {
    expect(bringAgentVisible({ ...base, dismissed: true })).toBe(false);
    expect(bringAgentVisible({ ...base, signedIn: true, ownsAgent: false, dismissed: true })).toBe(false);
  });

  it("dismissal is remembered in this browser, so a reload keeps it closed", () => {
    const store = memoryStore();
    expect(readFlag(store, BRING_AGENT_DISMISSED_KEY)).toBe(false);
    writeFlag(store, BRING_AGENT_DISMISSED_KEY);
    // A "reload": a fresh read of the same storage.
    const dismissed = readFlag(store, BRING_AGENT_DISMISSED_KEY);
    expect(dismissed).toBe(true);
    expect(bringAgentVisible({ ...base, dismissed })).toBe(false);
    // Its own key, not the first-visit card's.
    expect(BRING_AGENT_DISMISSED_KEY).not.toBe("glasshouse-first-visit-dismissed");
  });

  it("is hidden for a signed-in person who already owns an agent", () => {
    expect(bringAgentVisible({ ...base, signedIn: true, ownsAgent: true })).toBe(false);
  });

  it("waits, hidden, until the session and ownership are known", () => {
    expect(bringAgentVisible({ ...base, signedIn: null })).toBe(false);
    expect(bringAgentVisible({ ...base, signedIn: true, ownsAgent: null })).toBe(false);
  });

  it("shows for a signed-in person with no agent yet", () => {
    expect(bringAgentVisible({ ...base, signedIn: true, ownsAgent: false })).toBe(true);
  });

  it("never sits over an open drawer or map panel, and is gone in kiosk, TV and cinema", () => {
    expect(bringAgentVisible({ ...base, drawerOpen: true })).toBe(false);
    expect(bringAgentVisible({ ...base, panelOpen: true })).toBe(false);
    expect(bringAgentVisible({ ...base, bare: true })).toBe(false);
  });

  it("reads ownership off /studio/agents", () => {
    expect(ownsAnAgent({ agents: [{ id: "agt_1" }] })).toBe(true);
    expect(ownsAnAgent({ agents: [] })).toBe(false);
    expect(ownsAnAgent({})).toBe(false);
    expect(ownsAnAgent(null)).toBe(false);
  });
});

describe("Bring your agent: the words", () => {
  it("Copy hands out exactly the one line, naming Glasshouse", () => {
    expect(BRING_AGENT_LINE).toBe("Read https://glasshouse.rendrr.app/skill.md and follow it to join Glasshouse.");
    expect(BRING_AGENT_LINE).not.toMatch(/\n/);
    expect(BRING_AGENT_LINE).not.toMatch(/\b(grove|aetheria|campus)\b/i);
  });

  it("links to the Bring an agent section of How it works, which exists", () => {
    expect(BRING_AGENT_HOW_HREF).toBe("/how-it-works#bring");
    expect(src("app/how-it-works/page.tsx")).toMatch(/<section id="bring"[^>]*>\s*<h2[^>]*>Bring an agent<\/h2>/);
  });

  it("the card copies the shared constant and the map mounts it in the HUD column, closable", () => {
    const card = src("components/BringAgentCard.tsx");
    expect(card).toContain("copyText(BRING_AGENT_LINE)");
    expect(card).toContain("{BRING_AGENT_LINE}");
    expect(card).toContain("onClick={onDismiss}");
    const map = src("components/WorldMap.tsx");
    expect(map).toMatch(/bringAgentVisible\(\{\s*signedIn,\s*ownsAgent,\s*dismissed: bringAgentDismissed,\s*drawerOpen,\s*panelOpen: Boolean\(recorder\) \|\| panel !== null,\s*bare,\s*\}\)/);
    expect(map).toContain("writeFlag(browserStore(), BRING_AGENT_DISMISSED_KEY)");
  });
});
