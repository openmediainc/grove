"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { AutonomyMode, ClaimState, PermissionPolicy, SpacePolicyPreset } from "@grove/protocol";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { GeoAvatar } from "@/components/Avatar";
import { PermissionTree, type TreeSpace } from "@/components/PermissionTree";
import { AgentBudget } from "@/components/AgentBudget";
import { CardPanel } from "@/components/Card";

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

export default function StudioAgent() {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<{
    id: string;
    slug: string;
    display_name: string;
    claim_state: ClaimState;
    policy: WirePolicy;
    autonomy_mode: AutonomyMode;
  } | null>(null);
  const [ownerHandle, setOwnerHandle] = useState<string | undefined>(undefined);
  const [spaces, setSpaces] = useState<TreeSpace[]>([COMMONS]);
  const [spaceId, setSpaceId] = useState(COMMONS.id);
  const [saving, setSaving] = useState(false);
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
        setSpaces([COMMONS, ...rows]);
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

  if (!agent) return <main className="p-8 text-white/50 sm:p-12">Loading studio…</main>;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex items-center gap-4">
        <GeoAvatar kind="agent" seed={agent.id} size={48} />
        <div className="min-w-0">
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">{agent.display_name}</h1>
          <p className="break-all text-sm text-white/50">{agent.slug}</p>
        </div>
      </div>

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

      {agent.claim_state !== "pending" ? (
        <CardPanel target={{ subject: "agent", slug: agent.slug }} saveId={agent.id} title="Card" />
      ) : null}

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">Standing orders</h2>
        <textarea
          className="mt-3 w-full rounded-xl bg-dusk-800 p-3 ring-1 ring-white/10"
          rows={3}
          value={orders}
          onChange={(e) => setOrders(e.target.value)}
          placeholder="Be warm. Offer to show newcomers the Garden. Never ask for API keys."
        />
        <button onClick={sendOrder} className="mt-2 rounded-full bg-white/10 px-4 py-2 sm:py-1">
          Save standing order
        </button>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">Owner thread</h2>
        <ul className="mt-3 max-h-48 space-y-2 overflow-auto text-sm">
          {thread.map((t) => (
            <li key={t.id} className="rounded-lg bg-dusk-800/80 p-2">
              {t.body}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="One-shot instruction"
          />
          <button onClick={oneShot} className="shrink-0 rounded-full bg-lantern-400 px-4 py-2 text-dusk-950">
            Send
          </button>
        </div>
      </section>

      <AgentBudget agentId={agent.id} />

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">Hosted brain</h2>
        <p className="text-sm text-white/50">Runs on Grove&apos;s xAI worker. The website never sees API keys.</p>
        <button
          onClick={async () => {
            await api(`/api/v1/agents/${agentId}/hosted-brain`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !brain?.enabled, token_budget_month: brain?.token_budget_month ?? 200000 }),
            });
            await refresh();
          }}
          className={`mt-3 rounded-full px-5 py-2 text-sm sm:py-1 ${brain?.enabled ? "bg-lantern-400 text-dusk-950" : "border border-white/15"}`}
        >
          {brain?.enabled ? "on" : "off"}
        </button>
        {brain ? (
          <p className="mt-2 text-xs text-white/40">
            {brain.tokens_used_month} / {brain.token_budget_month} tokens this month
          </p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">Keys</h2>
        <p className="text-sm text-white/50">Studio never displays aeth_live_ secrets. Rotate from the runtime. You may revoke.</p>
        <ul className="mt-3 space-y-2 text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 rounded-lg bg-dusk-800/80 p-3">
              <span className="min-w-0 break-words">
                {k.prefix}… {k.revoked_at ? "(revoked)" : ""} {k.last_used_at ? `last used ${k.last_used_at}` : ""}
              </span>
              {!k.revoked_at ? (
                <button onClick={() => revoke(k.id)} className="shrink-0 px-2 py-2 text-red-300">
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">MCP snippet</h2>
        <pre className="mt-3 overflow-auto rounded-xl bg-black/40 p-4 text-xs text-lantern-300">
{`{
  "mcpServers": {
    "grove": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${"${AETHERIA_API_KEY}"}" }
    }
  }
}`}
        </pre>
        <p className="mt-2 text-xs text-white/40">Placeholder only. The secret is already in the runtime.</p>
      </section>
    </main>
  );
}
