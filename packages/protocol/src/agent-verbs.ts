/** Agent loop → campus verb. Keep in sync with apps/web/lib/agent-verbs.ts */

export type AgentVerb =
  | "idle"
  | "offline"
  | "think"
  | "tool"
  | "read"
  | "say"
  | "wait"
  | "error"
  | "blocked";

export const VERB_LABEL: Record<AgentVerb, string> = {
  idle: "idle",
  offline: "asleep",
  think: "thinking",
  tool: "tool",
  read: "reading",
  say: "speaking",
  wait: "waiting",
  error: "fault",
  blocked: "blocked",
};

export function isActiveVerb(verb: AgentVerb): boolean {
  return verb !== "idle" && verb !== "offline";
}

export function groveVerb(activity?: string | null, connection?: string | null): AgentVerb {
  const conn = (connection ?? "").toLowerCase();
  const act = (activity ?? "idle").toLowerCase();
  if (conn === "offline") return "offline";
  if (act === "error") return "error";
  if (act === "chatting" || act === "performing") return "say";
  if (act === "working") return "tool";
  if (act === "reading") return "read";
  if (act === "listening") return "wait";
  if (act === "idle" && conn === "live") return "think";
  return "idle";
}

export function paperclipVerb(input: {
  status?: string | null;
  lastHeartbeatAt?: string | null;
  now?: number;
  issueStatus?: string | null;
  executionState?: string | null;
}): AgentVerb {
  const status = (input.status ?? "idle").toLowerCase();
  const issue = (input.issueStatus ?? "").toLowerCase();
  const exec = (input.executionState ?? "").toLowerCase();
  if (status === "error" || status === "fault") return "error";
  if (status === "paused") return "wait";
  if (issue === "blocked") return "blocked";
  const running =
    ["running", "in_progress", "in-progress", "executing", "working", "busy"].includes(status) ||
    ["running", "executing", "in_progress", "in-progress"].includes(exec) ||
    issue === "in_progress" ||
    issue === "in-progress" ||
    issue === "doing";
  if (running) return "tool";
  const hb = input.lastHeartbeatAt;
  const now = input.now ?? Date.now();
  if (hb) {
    const age = now - Date.parse(hb);
    if (Number.isFinite(age) && age >= 0 && age < 15 * 60 * 1000) return "think";
    if (Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000) return "idle";
  }
  return "offline";
}

export type VerbRegion = "plaza" | "library" | "workshop" | "stage" | "garden" | "board";

export function regionForVerb(
  verb: AgentVerb,
  role?: string | null,
  fallback: VerbRegion = "workshop",
): VerbRegion {
  if (verb === "error" || verb === "blocked") return "board";
  if (verb === "say") return "plaza";
  if (verb === "read") return "library";
  if (verb === "wait") return "stage";
  if (verb === "tool" || verb === "think") return "workshop";
  const r = (role ?? "").toLowerCase();
  if (r === "ceo") return "plaza";
  if (r === "general") return "library";
  if (r === "engineer") return "workshop";
  return fallback;
}
