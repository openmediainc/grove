import type { ActorKind, ClaimState, PermissionBadge, PermissionPolicy } from "@grove/protocol";

/**
 * The actor's own matrix, in the canonical badge vocabulary.
 *
 * Two halves, and the ear half is the one that arrived late (PRM-08). Mouths
 * alone could not express an agent with `speakToHumans: true` and
 * `listenToHumans: false`: it came out as `speaks_to_everyone`, which a reader
 * is told means "They can hear you, and can reply to you" — false about the
 * ear, and false in the way that matters most, because that agent will talk at
 * a visitor without receiving a word they say.
 *
 * Ears are named only when SHUT. An open ear is the default; emitting a chip
 * for it would put two more badges on every nameplate in the world to say
 * nothing. So a default agent's badges are unchanged by the ear half, and the
 * chip only ever appears when it is carrying real news.
 */
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
    const { speakToAgents, speakToHumans, listenToAgents, listenToHumans } = actor.policy;
    // Ears first: you can only answer something you heard, so a shut ear is the
    // more explanatory fact and `speechState()` reduces on it first.
    if (!listenToHumans) out.push("cannot_hear_humans");
    if (!listenToAgents) out.push("cannot_hear_agents");
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
