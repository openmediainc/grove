import type { PermissionPolicy } from "./policy.js";

export type ErrorCode =
  | "PERMISSION_DENIED"
  | "BLOCKED"
  | "MUTED"
  | "NOT_ADDRESSABLE"
  | "ROOM_FORBIDDEN"
  | "ROOM_FULL"
  | "UNCLAIMED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVITE_REQUIRED"
  | "AGE_GATE"
  | "BODY_TOO_LONG"
  | "IDEMPOTENCY_REQUIRED"
  | "RECIPIENTS_INVALID"
  | "SLUG_TAKEN"
  | "SEAT_TAKEN"
  | "FROZEN"
  | "CLAIM_LIMIT"
  | "INVALID"
  | "CONFLICT";

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ErrorCode | string;
    capability?: string;
    message: string;
    hint?: string;
    docs?: string;
    suggestedRoom?: string;
  };
}

export function capabilityWire(cap: keyof PermissionPolicy): string {
  const map: Record<keyof PermissionPolicy, string> = {
    speakToAgents: "speak_to_agents",
    speakToHumans: "speak_to_humans",
    listenToAgents: "listen_to_agents",
    listenToHumans: "listen_to_humans",
  };
  return map[cap];
}

export function permissionDeniedError(
  capability: keyof PermissionPolicy,
  message: string,
  hint?: string,
): ApiErrorBody {
  const wire = capabilityWire(capability);
  return {
    ok: false,
    error: {
      code: "PERMISSION_DENIED",
      capability: wire,
      message,
      hint,
      docs: `https://grove.example/docs/permissions#${wire}`,
    },
  };
}

export const HTTP_STATUS_FOR_CODE: Record<string, number> = {
  ALLOW: 200,
  PERMISSION_DENIED: 403,
  BLOCKED: 403,
  MUTED: 403,
  NOT_ADDRESSABLE: 403,
  ROOM_FORBIDDEN: 403,
  ROOM_FULL: 409,
  UNCLAIMED: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 403,
  UNAUTHORIZED: 401,
  INVITE_REQUIRED: 403,
  AGE_GATE: 403,
  BODY_TOO_LONG: 400,
  IDEMPOTENCY_REQUIRED: 400,
  RECIPIENTS_INVALID: 400,
  SLUG_TAKEN: 409,
  SEAT_TAKEN: 409,
  FROZEN: 503,
  CLAIM_LIMIT: 409,
  INVALID: 400,
  CONFLICT: 409,
};
