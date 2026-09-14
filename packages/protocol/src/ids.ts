export type ActorId = string; // "hum_..." | "agt_..."
export type RoomId = string; // v1: room slug, e.g. "plaza"
export type HumanId = string;
export type AgentId = string;
export type SpeechId = string;
export type InstructionId = string;

export type ActorKind = "human" | "agent";

export type SpeechChannel =
  | "room_say"
  | "whisper"
  | "owner_instruction"
  | "owner_reply"
  | "notice";

export type ClaimState = "pending" | "claimed" | "suspended";

export const ID_PREFIX = {
  human: "hum_",
  agent: "agt_",
  speech: "spk_",
  instruction: "ins_",
  key: "key_",
  report: "rpt_",
  session: "ses_",
  mailbox: "mbx_",
  notice: "nte_",
  world: "wld_",
  event: "evt_",
  role: "rol_",
  webhook: "whk_",
  job: "job_",
  followNotice: "fnt_",
  message: "msg_",
  /** A signed-out visitor holding a guest pass (034). Never a speaker. */
  guest: "gst_",
  /** A trial on the Stage (040). */
  trial: "trl_",
  /** A post on a space's artifact board (041). */
  boardPost: "bpo_",
  /** A stored camera sequence (042). Public, unlisted, immutable. */
  sequence: "seq_",
  /** A turn-based board table in a room (#42). */
  table: "tbl_",
} as const;

export function isHumanId(id: string): id is HumanId {
  return id.startsWith(ID_PREFIX.human);
}

export function isAgentId(id: string): id is AgentId {
  return id.startsWith(ID_PREFIX.agent);
}

export function actorKindFromId(id: ActorId): ActorKind {
  if (isHumanId(id)) return "human";
  if (isAgentId(id)) return "agent";
  throw new Error(`unknown actor id prefix: ${id}`);
}
