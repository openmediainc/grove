export type PaperclipAgentView = {
  id: string;
  name: string;
  status: string;
  role: string;
  title: string | null;
  adapterType: string;
  lastHeartbeatAt: string | null;
};

export type PaperclipIssueView = {
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  executionState: string | null;
  title: string;
};

const AGENT_ALLOWED = new Set(["id", "name", "status", "role", "title", "adapterType", "lastHeartbeatAt"]);
const ISSUE_ALLOWED = new Set(["identifier", "status", "assigneeAgentId", "executionState", "title"]);

export function sanitizePaperclipAgent(raw: unknown): PaperclipAgentView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const name = typeof o.name === "string" ? o.name : "";
  if (!id || !name) return null;
  const view: PaperclipAgentView = {
    id,
    name: name.slice(0, 80),
    status: typeof o.status === "string" ? o.status.slice(0, 32) : "idle",
    role: typeof o.role === "string" ? o.role.slice(0, 32) : "general",
    title: typeof o.title === "string" ? o.title.slice(0, 80) : null,
    adapterType: typeof o.adapterType === "string" ? o.adapterType.slice(0, 48) : "unknown",
    lastHeartbeatAt: typeof o.lastHeartbeatAt === "string" ? o.lastHeartbeatAt : null,
  };
  for (const k of Object.keys(view) as Array<keyof PaperclipAgentView>) {
    if (!AGENT_ALLOWED.has(k)) delete (view as Record<string, unknown>)[k];
  }
  return view;
}

export function sanitizePaperclipIssue(raw: unknown): PaperclipIssueView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const identifier = typeof o.identifier === "string" ? o.identifier.slice(0, 16) : "";
  if (!identifier) return null;
  const view: PaperclipIssueView = {
    identifier,
    status: typeof o.status === "string" ? o.status.slice(0, 32) : "unknown",
    assigneeAgentId: typeof o.assigneeAgentId === "string" ? o.assigneeAgentId : null,
    executionState: typeof o.executionState === "string" ? o.executionState.slice(0, 32) : null,
    title: typeof o.title === "string" ? o.title.slice(0, 48) : "",
  };
  for (const k of Object.keys(view) as Array<keyof PaperclipIssueView>) {
    if (!ISSUE_ALLOWED.has(k)) delete (view as Record<string, unknown>)[k];
  }
  return view;
}

export function paperclipOrigin(): string {
  return (process.env.PAPERCLIP_ORIGIN ?? "http://127.0.0.1:3100").replace(/\/$/, "");
}

export async function fetchPaperclipAgents(timeoutMs = 1500): Promise<{
  ok: boolean;
  agents: PaperclipAgentView[];
  issues: PaperclipIssueView[];
}> {
  const origin = paperclipOrigin();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const companiesRes = await fetch(`${origin}/api/companies`, { signal: ac.signal });
    if (!companiesRes.ok) return { ok: false, agents: [], issues: [] };
    const companies = (await companiesRes.json()) as Array<{ id?: string }>;
    const cid = companies[0]?.id;
    if (!cid) return { ok: true, agents: [], issues: [] };
    const [agentsRes, issuesRes] = await Promise.all([
      fetch(`${origin}/api/companies/${cid}/agents`, { signal: ac.signal }),
      fetch(`${origin}/api/companies/${cid}/issues`, { signal: ac.signal }),
    ]);
    if (!agentsRes.ok) return { ok: false, agents: [], issues: [] };
    const rawAgents = (await agentsRes.json()) as unknown[];
    const agents = rawAgents.map(sanitizePaperclipAgent).filter((a): a is PaperclipAgentView => Boolean(a));
    let issues: PaperclipIssueView[] = [];
    if (issuesRes.ok) {
      const rawIssues = (await issuesRes.json()) as unknown[];
      issues = rawIssues.map(sanitizePaperclipIssue).filter((i): i is PaperclipIssueView => Boolean(i));
    }
    return { ok: true, agents, issues };
  } catch {
    return { ok: false, agents: [], issues: [] };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Budgets and spend (AGT-11).
//
// Deliberately NOT part of sanitizePaperclipAgent: that view is served on the
// public minimap, and what an agent costs is not public. This is read only by
// GET /usage, for operators — Paperclip has no notion of a Grove owner, so the
// operator of this Mini is the only human it can honestly be shown to.
//
// Paperclip keeps integer cents. Two of its zeros mean different things and
// must not be collapsed:
//   * budgetMonthlyCents = 0 is "no budget", not "a budget of $0";
//   * spentMonthlyCents  = 0 is only a real zero if Paperclip has cost events
//     for that agent. An agent absent from /costs/by-agent never reported, so
//     its spend is "not reported" (null), never $0.00.
// ---------------------------------------------------------------------------

export type PaperclipBudgetView = {
  id: string;
  name: string;
  /** Null = no budget set in Paperclip. */
  budgetMonthlyCents: number | null;
  /** Null = Paperclip has no cost events for this agent: not reported. */
  spentMonthlyCents: number | null;
};

export type PaperclipBudgets = {
  ok: boolean;
  company: { budgetMonthlyCents: number | null; spentMonthlyCents: number | null } | null;
  agents: PaperclipBudgetView[];
};

function cents(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Pure, so the zero rules above are testable without a Paperclip. */
export function sanitizePaperclipBudgets(rawAgents: unknown, rawByAgent: unknown, rawSummary: unknown): PaperclipBudgets {
  const reported = new Set<string>();
  if (Array.isArray(rawByAgent)) {
    for (const row of rawByAgent) {
      const id = row && typeof row === "object" ? (row as Record<string, unknown>).agentId : null;
      if (typeof id === "string") reported.add(id);
    }
  }
  const agents: PaperclipBudgetView[] = [];
  for (const raw of Array.isArray(rawAgents) ? rawAgents : []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") continue;
    const budget = cents(o.budgetMonthlyCents);
    agents.push({
      id: o.id,
      name: o.name.slice(0, 80),
      budgetMonthlyCents: budget && budget > 0 ? budget : null,
      spentMonthlyCents: reported.has(o.id) ? cents(o.spentMonthlyCents) : null,
    });
  }
  let company: PaperclipBudgets["company"] = null;
  if (rawSummary && typeof rawSummary === "object") {
    const s = rawSummary as Record<string, unknown>;
    const budget = cents(s.budgetCents);
    company = {
      budgetMonthlyCents: budget && budget > 0 ? budget : null,
      // The company total is only as reported as its agents: with no cost
      // events anywhere, its 0 is the same unknown.
      spentMonthlyCents: reported.size > 0 ? cents(s.spendCents) : null,
    };
  }
  return { ok: true, company, agents };
}

export async function fetchPaperclipBudgets(timeoutMs = 1500): Promise<PaperclipBudgets> {
  const origin = paperclipOrigin();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const companiesRes = await fetch(`${origin}/api/companies`, { signal: ac.signal });
    if (!companiesRes.ok) return { ok: false, company: null, agents: [] };
    const companies = (await companiesRes.json()) as Array<{ id?: string }>;
    const cid = companies[0]?.id;
    if (!cid) return { ok: true, company: null, agents: [] };
    const [agentsRes, byAgentRes, summaryRes] = await Promise.all([
      fetch(`${origin}/api/companies/${cid}/agents`, { signal: ac.signal }),
      fetch(`${origin}/api/companies/${cid}/costs/by-agent`, { signal: ac.signal }),
      fetch(`${origin}/api/companies/${cid}/costs/summary`, { signal: ac.signal }),
    ]);
    if (!agentsRes.ok) return { ok: false, company: null, agents: [] };
    return sanitizePaperclipBudgets(
      await agentsRes.json(),
      byAgentRes.ok ? await byAgentRes.json() : null,
      summaryRes.ok ? await summaryRes.json() : null,
    );
  } catch {
    return { ok: false, company: null, agents: [] };
  } finally {
    clearTimeout(t);
  }
}
