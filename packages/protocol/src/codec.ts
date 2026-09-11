/** Wire JSON is snake_case. TypeScript is camelCase. This is the only legal mapping. */

const CAMEL_TO_SNAKE: Record<string, string> = {
  speakToAgents: "speak_to_agents",
  speakToHumans: "speak_to_humans",
  listenToAgents: "listen_to_agents",
  listenToHumans: "listen_to_humans",
  addressableByAgents: "addressable_by_agents",
  addressableByHumans: "addressable_by_humans",
  overhearableByAgents: "overhearable_by_agents",
  overhearableByHumans: "overhearable_by_humans",
  ownerHumanId: "owner_human_id",
  claimState: "claim_state",
  autonomyMode: "autonomy_mode",
  homeRoomId: "home_room_id",
  displayName: "display_name",
  avatarId: "avatar_id",
  statusText: "status_text",
  createdAt: "created_at",
  lastSeenAt: "last_seen_at",
  claimedAt: "claimed_at",
  expiresAt: "expires_at",
  ageAttestedAt: "age_attested_at",
  emailVerifiedAt: "email_verified_at",
  allowsRoomSay: "allows_room_say",
  allowsWhisper: "allows_whisper",
  spectatorVisible: "spectator_visible",
  sayLimitPerMin: "say_limit_per_min",
  seatIndex: "seat_index",
  actorId: "actor_id",
  roomId: "room_id",
  senderId: "sender_id",
  senderKind: "sender_kind",
  targetId: "target_id",
  graphemeCount: "grapheme_count",
  idempotencyKey: "idempotency_key",
  speechId: "speech_id",
  generatedAt: "generated_at",
  pendingInstructions: "pending_instructions",
  standingOrders: "standing_orders",
  mailboxUnread: "mailbox_unread",
  suggestedActions: "suggested_actions",
  ttlSeconds: "ttl_seconds",
  claimUrl: "claim_url",
  agentId: "agent_id",
  deliveredCount: "delivered_count",
  visibleInUi: "visible_in_ui",
  ownerHandle: "owner_handle",
  sayMs: "say_ms",
  moveMs: "move_ms",
  ackedAt: "acked_at",
  apiKey: "api_key",
  keyId: "key_id",
  lastUsedAt: "last_used_at",
  revokedAt: "revoked_at",
  inviteCode: "invite_code",
  ageAttested: "age_attested",
  devLoginUrl: "dev_login_url",
  suggestedRoom: "suggested_room",
  occupancy: "occupancy",
  worldId: "world_id",
  cadenceMinutes: "cadence_minutes",
  holderAgentId: "holder_agent_id",
  assignedAt: "assigned_at",
  startsAt: "starts_at",
  endsAt: "ends_at",
  createdBy: "created_by",
  tokenBudgetMonth: "token_budget_month",
  tokensUsedMonth: "tokens_used_month",
  lastTickAt: "last_tick_at",
};

const SNAKE_TO_CAMEL: Record<string, string> = Object.fromEntries(
  Object.entries(CAMEL_TO_SNAKE).map(([k, v]) => [v, k]),
);

function renameKeyToSnake(key: string): string {
  if (CAMEL_TO_SNAKE[key]) return CAMEL_TO_SNAKE[key]!;
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function renameKeyToCamel(key: string): string {
  if (SNAKE_TO_CAMEL[key]) return SNAKE_TO_CAMEL[key]!;
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function toSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnake);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[renameKeyToSnake(k)] = toSnake(v);
    }
    return out;
  }
  return value;
}

export function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[renameKeyToCamel(k)] = toCamel(v);
    }
    return out;
  }
  return value;
}

export function ok<T>(data: T): { ok: true } & T {
  return { ok: true, ...data };
}
