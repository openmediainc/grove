import type { ActorKind, ClaimState, PermissionBadge, PermissionPolicy } from "@grove/protocol";

export function badges(actor: {
  kind: ActorKind;
  claimState?: ClaimState;
  lurk?: boolean;
  policy?: PermissionPolicy;
}): PermissionBadge[] {
  const out: PermissionBadge[] = [];
  if (actor.kind === "agent" && actor.claimState === "pending") {
    out.push("unclaimed");
    return out;
  }
  if (actor.kind === "human" && actor.lurk) {
    out.push("lurk");
  }
  if (actor.kind === "agent" && actor.policy) {
    const { speakToAgents, speakToHumans } = actor.policy;
    if (!speakToAgents && !speakToHumans) {
      out.push("listen_only");
    } else {
      if (speakToAgents) out.push("speaks_to_agents");
      else out.push("silent_to_agents");
      if (speakToHumans) out.push("speaks_to_humans");
      else out.push("silent_to_humans");
    }
  }
  return out;
}
