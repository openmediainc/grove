/**
 * `/me`, the You page: your agents, your spaces, what today cost.
 *
 * Pure shaping of three reads the API already scopes to the signed-in human
 * (/studio/agents, /worlds, /usage?scope=mine), so it is testable without a
 * browser. Nothing here widens what those reads returned.
 */
import { WORLD_ID } from "@grove/protocol";
import type { Budget, Totals, UsageDay } from "./cost";

/** One access vocabulary on pages (DECISIONS #3): Open · Watch only · Private. */
export function accessWord(preset: string): "Open" | "Watch only" | "Private" {
  if (preset === "public_write") return "Open";
  if (preset === "public_view") return "Watch only";
  return "Private";
}

export type WireWorld = {
  id: string;
  slug: string;
  name: string;
  owner_human_id: string | null;
  policy_preset: string;
  archived_at?: string | null;
};

export type YourSpace = { id: string; slug: string; name: string; access: string; role: "owner" | "member" };

/**
 * Spaces you own first, then spaces you are a member of, each by name. The
 * commons is everyone's and archived plots are given back, so neither is "yours".
 */
export function yourSpaces(worlds: WireWorld[], humanId: string): YourSpace[] {
  return worlds
    .filter((w) => w.id !== WORLD_ID && !w.archived_at)
    .map(
      (w): YourSpace => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        access: accessWord(w.policy_preset),
        role: w.owner_human_id === humanId ? "owner" : "member",
      }),
    )
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1));
}

export type OwnedAgentWire = { id: string; slug: string; display_name: string; claim_state: string };
export type LiveBody = { id: string; verb: string | null; detail: string | null; stalled: boolean };
export type AgentSpend = Totals & { agent_id: string; budget: Budget | null };

export type YourAgent = OwnedAgentWire & {
  body: LiveBody | null;
  spend: AgentSpend | null;
};

/** Your agents with their live body (if on the map) and today's reported spend (if any). */
export function yourAgents(owned: OwnedAgentWire[], bodies: LiveBody[], usage: Pick<UsageDay, "by_agent"> | null): YourAgent[] {
  const byBody = new Map(bodies.map((b) => [b.id, b]));
  const bySpend = new Map((usage?.by_agent ?? []).map((a) => [a.agent_id, a]));
  return owned.map((a) => ({ ...a, body: byBody.get(a.id) ?? null, spend: bySpend.get(a.id) ?? null }));
}
