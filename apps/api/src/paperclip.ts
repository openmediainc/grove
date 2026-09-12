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
