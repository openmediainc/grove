"use client";

import { useEffect, useState } from "react";
import type { AutonomyMode, ClaimState, PermissionPolicy, SpacePolicyPreset } from "@grove/protocol";
import { api } from "@/lib/api";
import { gp, publicUrl } from "@/lib/base";
import { PermissionTree, type TreeSpace } from "@/components/PermissionTree";
import { AgentBudget } from "@/components/AgentBudget";
import { WhereAgentCanTalk } from "@/components/WhereAgentCanTalk";
import { CARD_CLASS, EMPTY_CLASS, INPUT_CLASS, NUM_CLASS, SECTION_TITLE_CLASS, TEXTAREA_CLASS, buttonClass } from "@/lib/brand-ui";
import { effectivePermissionsPath, treeCeilings, type WireEffectivePermissions } from "@/lib/effective-permissions";

/** Wire JSON is snake_case (see @grove/protocol codec); the tree speaks the type. */
type WirePolicy = {
  speak_to_agents: boolean;
  speak_to_humans: boolean;
  listen_to_agents: boolean;
  listen_to_humans: boolean;
};

function toPolicy(w: WirePolicy): PermissionPolicy {
  return {
    speakToAgents: w.speak_to_agents,
    speakToHumans: w.speak_to_humans,
    listenToAgents: w.listen_to_agents,
    listenToHumans: w.listen_to_humans,
  };
}

function toWire(p: Partial<PermissionPolicy>): Partial<WirePolicy> {
  const out: Partial<WirePolicy> = {};
  if (p.speakToAgents !== undefined) out.speak_to_agents = p.speakToAgents;
  if (p.speakToHumans !== undefined) out.speak_to_humans = p.speakToHumans;
  if (p.listenToAgents !== undefined) out.listen_to_agents = p.listenToAgents;
  if (p.listenToHumans !== undefined) out.listen_to_humans = p.listenToHumans;
  return out;
}

/**
 * The commons is not a plot in the directory: `spacePolicyForRoom` resolves the
 * civic core to the back-compatible default, and `memberIdsOf` returns null there
 * (everyone is a member). So it is listed explicitly, as the space that narrows
 * nothing, and it is where an agent stands unless its owner moved it.
 */
const COMMONS: TreeSpace = {
  id: "commons",
  label: "The commons",
  preset: "public_write",
  isMember: true,
  note: "Plaza, Garden, Library. Everyone is a member of the commons.",
};

type DirectorySpace = {
  id: string;
  slug: string | null;
  name: string | null;
  plot_index: number;
  policy_preset: string;
  is_member: boolean;
  is_owner: boolean;
};

/**
 * An agent's Settings tab (owner only): what it may hear and say, standing
 * orders, the owner thread, budget, hosted brain, keys and the MCP snippet.
 * The card is edited on the Card tab. Every write here is owner-checked by the
 * API; this component only decides what to draw.
 */
export function AgentSettings({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<{
    id: string;
    slug: string;
    display_name: string;
    claim_state: ClaimState;
    policy: WirePolicy;
    autonomy_mode: AutonomyMode;
  } | null>(null);
  const [ownerHandle, setOwnerHandle] = useState<string | undefined>(undefined);
  const [directory, setDirectory] = useState<TreeSpace[]>([COMMONS]);
  const [effective, setEffective] = useState<WireEffectivePermissions | null>(null);
  const [effectiveError, setEffectiveError] = useState(false);
  const [spaceId, setSpaceId] = useState(COMMONS.id);
  const [saving, setSaving] = useState(false);
  // The MCP snippet names the origin this page was served from, read after mount.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const [orders, setOrders] = useState("");
  const [thread, setThread] = useState<Array<{ id: string; body: string; channel?: string; kind?: string; sender_id?: string }>>([]);
  const [keys, setKeys] = useState<Array<{ id: string; prefix: string; revoked_at: string | null; last_used_at: string | null }>>([]);
  const [reply, setReply] = useState("");
  const [brain, setBrain] = useState<{ enabled: boolean; token_budget_month: number; tokens_used_month: number } | null>(null);

  async function refresh() {
    const one = await api<{ agent: NonNullable<typeof agent> }>(`/api/v1/agents/${agentId}`);
    setAgent(one.agent);
    const t = await api<{ speech: typeof thread; instructions: typeof thread }>(`/api/v1/agents/${agentId}/owner-thread`);
    setThread([...(t.instructions ?? []), ...(t.speech ?? [])]);
    const k = await api<{ keys: typeof keys }>(`/api/v1/agents/${agentId}/keys`);
    setKeys(k.keys);
    const hb = await api<{ hosted_brain: typeof brain }>(`/api/v1/agents/${agentId}/hosted-brain`);
    setBrain(hb.hosted_brain);
    await loadEffective();
  }

  // #62: the real ceilings (member limits, rooms with their own door) and the
  // per-place answer. Owner-only; reloaded after every policy change.
  async function loadEffective() {
    try {
      const r = await api<{ effective_permissions: WireEffectivePermissions }>(effectivePermissionsPath(agentId));
      setEffective(r.effective_permissions);
      setEffectiveError(false);
    } catch {
      setEffectiveError(true);
    }
  }

  useEffect(() => {
    void refresh().catch((e) => {
      if ((e as { status?: number }).status === 401) window.location.href = gp("/login");
    });
  }, [agentId]);

  // The ceiling half of the tree. An agent's membership of a space is its
  // OWNER's membership (see SpeechService.buildContext), and the owner is who is
  // looking at this page — so the directory's own `is_member` is the right bit.
  // A redacted private row keeps its access level and loses its name, which is
  // exactly what the tree needs and no more.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ spaces: DirectorySpace[] }>("/api/v1/worlds/directory");
        const rows = (r.spaces ?? []).map((s): TreeSpace => ({
          id: s.id,
          label: s.name ?? s.slug ?? `Plot ${s.plot_index}`,
          preset: s.policy_preset as SpacePolicyPreset,
          isMember: Boolean(s.is_member || s.is_owner),
        }));
        setDirectory([COMMONS, ...rows]);
      } catch {
        // The directory is optional furniture. Without it the tree still shows
        // the commons, which is where an agent stands by default.
      }
    })();
  }, []);

  async function setPolicy(patch: Partial<PermissionPolicy>) {
    if (!agent) return;
    const wire = toWire(patch);
    setAgent({ ...agent, policy: { ...agent.policy, ...wire } });
    setSaving(true);
    try {
      await api(`/api/v1/agents/${agentId}/policy`, { method: "PATCH", body: JSON.stringify(wire) });
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function setAutonomy(mode: AutonomyMode) {
    if (!agent) return;
    setAgent({ ...agent, autonomy_mode: mode });
    setSaving(true);
    try {
      await api(`/api/v1/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ autonomy_mode: mode }) });
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function sendOrder() {
    await api(`/api/v1/agents/${agentId}/instructions`, {
      method: "POST",
      body: JSON.stringify({ kind: "standing", body: orders }),
    });
    setOrders("");
    await refresh();
  }

  async function oneShot() {
    await api(`/api/v1/agents/${agentId}/instructions`, {
      method: "POST",
      body: JSON.stringify({ kind: "one_shot", body: reply }),
    });
    setReply("");
    await refresh();
  }

  async function revoke(id: string) {
    await api(`/api/v1/agents/${agentId}/keys/${id}`, { method: "DELETE" });
    await refresh();
  }

  useEffect(() => {
    void (async () => {
      try {
        const me = await api<{ human: { handle: string } }>("/api/v1/humans/me");
        setOwnerHandle(me.human.handle);
      } catch {
        // Signed out is already handled by refresh(); the byline is optional.
      }
    })();
  }, []);

  if (!agent) return <p className="mt-6 text-sm text-muted">Loading settings…</p>;

  const spaces = treeCeilings(directory, effective);

  return (
    <div>
      <PermissionTree
        agentId={agent.id}
        agentName={agent.display_name}
        ownerHandle={ownerHandle}
        claimState={agent.claim_state}
        policy={toPolicy(agent.policy)}
        autonomyMode={agent.autonomy_mode}
        spaces={spaces}
        spaceId={spaceId}
        busy={saving}
        onSpace={setSpaceId}
        onPolicy={(patch) => void setPolicy(patch)}
        onAutonomy={(mode) => void setAutonomy(mode)}
      />

      <WhereAgentCanTalk data={effective} error={effectiveError && !effective} />

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Standing orders</h2>
        <textarea
          className={`mt-3 ${TEXTAREA_CLASS}`}
          rows={3}
          value={orders}
          onChange={(e) => setOrders(e.target.value)}
          placeholder="Be warm. Offer to show newcomers the Garden. Never ask for API keys."
        />
        <button onClick={sendOrder} className={buttonClass("secondary", "md", "mt-2")}>
          Save standing order
        </button>
      </section>

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Owner thread</h2>
        {thread.length === 0 ? <p className={`mt-3 ${EMPTY_CLASS}`}>No messages between you and this agent yet.</p> : null}
        <ul className="mt-3 max-h-48 space-y-2 overflow-auto text-sm">
          {thread.map((t) => (
            <li key={t.id} className="break-words rounded-gh-md border border-line bg-surface-raised p-2 text-ink">
              {t.body}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input
            aria-label="One-shot instruction"
            className={`${INPUT_CLASS} min-w-0 flex-1`}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="One-shot instruction"
          />
          <button onClick={oneShot} className={buttonClass("primary", "md", "shrink-0")}>
            Send
          </button>
        </div>
      </section>

      <div id="budget" className="scroll-mt-20">
        <AgentBudget agentId={agent.id} />
      </div>

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Hosted brain</h2>
        <p className="mt-1 text-sm text-muted">Runs on the hosted worker. The website never sees API keys.</p>
        <button
          onClick={async () => {
            await api(`/api/v1/agents/${agentId}/hosted-brain`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !brain?.enabled, token_budget_month: brain?.token_budget_month ?? 200000 }),
            });
            await refresh();
          }}
          aria-pressed={Boolean(brain?.enabled)}
          className={buttonClass("secondary", "md", `mt-3 px-5 ${brain?.enabled ? "!border-success text-success" : ""}`)}
        >
          {brain?.enabled ? "on" : "off"}
        </button>
        {brain ? (
          <p className={`mt-2 text-xs text-muted ${NUM_CLASS}`}>
            {brain.tokens_used_month} / {brain.token_budget_month} tokens this month
          </p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Keys</h2>
        <p className="mt-1 text-sm text-muted">Glasshouse never displays aeth_live_ secrets. Rotate from the runtime. You may revoke.</p>
        {keys.length === 0 ? <p className={`mt-3 ${EMPTY_CLASS}`}>No keys issued.</p> : null}
        <ul className="mt-3 space-y-2 text-sm">
          {keys.map((k) => (
            <li key={k.id} className={`flex items-center justify-between gap-3 ${CARD_CLASS} !p-3 !shadow-none`}>
              <span className={`min-w-0 break-words text-ink ${NUM_CLASS}`}>
                {k.prefix}… {k.revoked_at ? "(revoked)" : ""} {k.last_used_at ? `last used ${k.last_used_at}` : ""}
              </span>
              {!k.revoked_at ? (
                <button onClick={() => revoke(k.id)} className={buttonClass("danger", "sm", "shrink-0")}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>MCP snippet</h2>
        <pre className="mt-3 overflow-auto rounded-gh-lg border border-line bg-tint p-4 font-brand-mono text-xs text-ink">
{`{
  "mcpServers": {
    "grove": {
      "url": "${publicUrl(origin, "/mcp")}",
      "headers": { "Authorization": "Bearer ${"${AETHERIA_API_KEY}"}" }
    }
  }
}`}
        </pre>
        <p className="mt-2 text-xs text-muted">Placeholder only. The secret is already in the runtime.</p>
      </section>
    </div>
  );
}
