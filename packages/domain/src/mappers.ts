import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  type Agent,
  type Human,
  type Presence,
  type Room,
  toCamel,
} from "@grove/protocol";

export function mapHuman(row: Record<string, unknown>): Human {
  const c = toCamel(row) as Record<string, unknown>;
  const privacy = (toCamel(c.privacy) ?? { overhearableByAgents: true }) as Human["privacy"];
  return {
    id: String(c.id),
    handle: String(c.handle),
    displayName: String(c.displayName),
    email: String(c.email),
    lurk: Boolean(c.lurk),
    privacy: {
      overhearableByAgents: privacy.overhearableByAgents !== false,
    },
    avatarId: String(c.avatarId),
    role: (c.role as Human["role"]) ?? "inhabitant",
    ageAttestedAt: new Date(String(c.ageAttestedAt)).toISOString(),
    createdAt: new Date(String(c.createdAt)).toISOString(),
  };
}

export function mapAgent(row: Record<string, unknown>): Agent {
  const c = toCamel(row) as Record<string, unknown>;
  const policy = { ...DEFAULT_AGENT_POLICY, ...((toCamel(c.policy) as object) ?? {}) };
  const privacy = { ...DEFAULT_AGENT_PRIVACY, ...((toCamel(c.privacy) as object) ?? {}) };
  return {
    id: String(c.id),
    slug: String(c.slug),
    displayName: String(c.displayName),
    description: (c.description as string | null) ?? null,
    ownerHumanId: (c.ownerHumanId as string | null) ?? null,
    claimState: c.claimState as Agent["claimState"],
    policy: {
      speakToAgents: Boolean((policy as Agent["policy"]).speakToAgents),
      speakToHumans: Boolean((policy as Agent["policy"]).speakToHumans),
      listenToAgents: Boolean((policy as Agent["policy"]).listenToAgents),
      listenToHumans: Boolean((policy as Agent["policy"]).listenToHumans),
    },
    privacy: {
      addressableByAgents: (privacy as Agent["privacy"]).addressableByAgents !== false,
      addressableByHumans: (privacy as Agent["privacy"]).addressableByHumans !== false,
      overhearableByAgents: (privacy as Agent["privacy"]).overhearableByAgents !== false,
      overhearableByHumans: (privacy as Agent["privacy"]).overhearableByHumans !== false,
    },
    autonomyMode: (c.autonomyMode as Agent["autonomyMode"]) ?? "hang_out",
    homeRoomId: String(c.homeRoomId ?? "plaza"),
    avatarId: String(c.avatarId),
    statusText: (c.statusText as string | null) ?? null,
    createdAt: new Date(String(c.createdAt)).toISOString(),
    lastSeenAt: c.lastSeenAt ? new Date(String(c.lastSeenAt)).toISOString() : null,
    claimedAt: c.claimedAt ? new Date(String(c.claimedAt)).toISOString() : null,
    expiresAt: c.expiresAt ? new Date(String(c.expiresAt)).toISOString() : null,
  };
}

export function mapRoom(row: Record<string, unknown>): Room {
  const c = toCamel(row) as Record<string, unknown>;
  return {
    id: String(c.id),
    slug: String(c.slug),
    name: String(c.name),
    kind: c.kind as Room["kind"],
    capacity: Number(c.capacity),
    allowsRoomSay: Boolean(c.allowsRoomSay),
    allowsWhisper: Boolean(c.allowsWhisper),
    spectatorVisible: Boolean(c.spectatorVisible),
    sayLimitPerMin: c.sayLimitPerMin == null ? null : Number(c.sayLimitPerMin),
    ownerHumanId: (c.ownerHumanId as string | null) ?? null,
    worldId: String(c.worldId ?? "aetheria-prime"),
  };
}

/**
 * Hot path: runs for every body on every minimap poll, and the rows it receives
 * are wide joins (display name, slug, avatar, policy, owner handle...). Running
 * `toCamel()` over the whole row to read eleven fields measured at 38ms of a
 * 102ms request — as much as all the SQL put together. Read the columns
 * directly instead. Both spellings are accepted so a caller that has already
 * camelised its row keeps working; the conversions are deliberately identical
 * to the previous implementation, so the serialised output is unchanged.
 */
export function mapPresence(row: Record<string, unknown>): Presence {
  const c = presenceField(row);
  return {
    actorId: String(c("actor_id", "actorId")),
    roomId: String(c("room_id", "roomId")),
    seatIndex: Number(c("seat_index", "seatIndex")),
    connection: c("connection", "connection") as Presence["connection"],
    mode: c("mode", "mode") as Presence["mode"],
    activity: c("activity", "activity") as Presence["activity"],
    lastSeenAt: new Date(String(c("last_seen_at", "lastSeenAt"))).toISOString(),
    verb: (c("verb", "verb") as Presence["verb"]) ?? null,
    detail: c("detail", "detail") ? String(c("detail", "detail")) : null,
    pulsedAt: c("pulsed_at", "pulsedAt") ? new Date(String(c("pulsed_at", "pulsedAt"))).toISOString() : null,
    url: c("url", "url") ? String(c("url", "url")) : null,
    errorText: c("error_text", "errorText") ? String(c("error_text", "errorText")) : null,
  };
}

export function policyToJson(p: Agent["policy"]): Record<string, boolean> {
  return {
    speak_to_agents: p.speakToAgents,
    speak_to_humans: p.speakToHumans,
    listen_to_agents: p.listenToAgents,
    listen_to_humans: p.listenToHumans,
  };
}

export function privacyToJson(p: Agent["privacy"] | Human["privacy"]): Record<string, boolean> {
  const rec = p as Record<string, boolean>;
  const out: Record<string, boolean> = {};
  if ("overhearableByAgents" in rec) out.overhearable_by_agents = rec.overhearableByAgents;
  if ("addressableByAgents" in rec) out.addressable_by_agents = rec.addressableByAgents;
  if ("addressableByHumans" in rec) out.addressable_by_humans = rec.addressableByHumans;
  if ("overhearableByHumans" in rec) out.overhearable_by_humans = rec.overhearableByHumans;
  return out;
}

/** Read a column by either spelling without walking the whole row. */
function presenceField(row: Record<string, unknown>) {
  return (snake: string, camel: string): unknown => row[snake] ?? row[camel];
}
