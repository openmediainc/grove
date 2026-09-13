import type { ActorId, ActorKind, Agent, Human, PolicyDecision, UndeliveredRecipient } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { undeliveredFor, type SpeechService } from "./speech.js";

/** Whispers older than this are not served, and are pruned by the sweep. */
export const WHISPER_RETENTION_DAYS = 30;
/** How often a process runs the prune. Retention is measured in days. */
export const WHISPER_PRUNE_EVERY_MS = 10 * 60_000;
/** Rows deleted per prune, so a backlog never makes one tick slow. */
const PRUNE_BATCH = 500;
export const WHISPER_HISTORY_MAX = 100;

export type WhisperReader = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/** One whisper as its reader sees it. `other` is the party that is not the reader. */
export interface WhisperHistoryItem {
  id: string;
  body: string;
  direction: "out" | "in";
  otherId: string;
  otherKind: ActorKind;
  untrusted: boolean;
  createdAt: string;
  /** Only on "out": why it did not land, as the say ack's replay spells it (code only). */
  undelivered: UndeliveredRecipient | null;
}

type Row = {
  id: string;
  sender_id: string;
  sender_kind: string;
  target_id: string | null;
  body: string;
  untrusted: boolean;
  created_at: string;
  status: string | null;
  filter_code: string | null;
};

/**
 * Whisper history (migration 032). Whispers were always written to `speech`;
 * this reads them back so a reload does not empty the log.
 *
 * ---------------------------------------------------------------------------
 * WHO READS
 * ---------------------------------------------------------------------------
 * The two parties and nobody else: the SQL selects only rows the reader sent or
 * was the target of. No public surface serves whispers (the chronicle and the
 * transcript are room_say only); operators keep what they already had through
 * reports and the moderation queue, which read `speech` directly.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES
 * ---------------------------------------------------------------------------
 * authorize() on the `whisper` channel with TODAY's permissions (blocks, mutes,
 * grants, privacy, policy, the room's ceilings and membership), via the same
 * `lineDecider` the room transcript uses:
 *
 *  - "in"  (reader was the target): shown only if it was delivered to the reader
 *    at the time AND the kernel would deliver it from that sender now. A block,
 *    a mute, a closed door or a revoked capability since hides it; nothing is
 *    deleted, so reopening shows it again.
 *  - "out" (reader sent it): shown unless the two are now blocked (either side),
 *    which hides the exchange from both. The sender keeps their own words
 *    otherwise, with the send-time refusal code if it did not land.
 */
export class WhisperService {
  private lastPruned = 0;

  constructor(
    private store: GroveStore,
    private speech: SpeechService,
  ) {}

  async history(reader: WhisperReader, roomId: string, limit = 50): Promise<WhisperHistoryItem[]> {
    const me = reader.kind === "human" ? reader.human.id : reader.agent.id;
    const n = Math.max(1, Math.min(WHISPER_HISTORY_MAX, Math.floor(limit) || 50));
    const { rows } = await this.store.pg.query<Row>(
      `SELECT s.id, s.sender_id, s.sender_kind, s.target_id, s.body, s.untrusted, s.created_at,
              d.status, d.filter_code
         FROM speech s
         LEFT JOIN speech_deliveries d ON d.speech_id = s.id AND d.recipient_id = s.target_id
        WHERE s.channel = 'whisper'
          AND s.room_id = $1
          AND s.created_at > now() - make_interval(days => $3)
          AND (s.sender_id = $2 OR s.target_id = $2)
          AND s.target_id IS NOT NULL
          AND s.sender_id <> s.target_id
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [roomId, me, WHISPER_RETENTION_DAYS, n],
    );
    if (!rows.length) return [];
    const decide = await this.speech.lineDecider(roomId, "whisper");
    const out: WhisperHistoryItem[] = [];
    for (const row of rows.reverse()) {
      const target = row.target_id!;
      const mine = row.sender_id === me;
      const decision = await decide(row, target);
      if (mine) {
        if (decision && isBlocked(decision)) continue;
        const code = row.status === "delivered" ? null : ((row.filter_code as PolicyDecision["code"] | null) ?? "PERMISSION_DENIED");
        out.push({
          id: row.id,
          body: row.body,
          direction: "out",
          otherId: target,
          otherKind: target.startsWith("agt_") ? "agent" : "human",
          untrusted: row.untrusted !== false,
          createdAt: new Date(String(row.created_at)).toISOString(),
          undelivered: code ? undeliveredFor(target as ActorId, { allow: false, code, reason: "" }) : null,
        });
        continue;
      }
      if (row.status !== "delivered") continue;
      if (!decision || !decision.emit.allow) continue;
      const d = decision.deliveries[0]?.decision;
      if (!d || !d.allow || d.code === "MUTED") continue;
      out.push({
        id: row.id,
        body: row.body,
        direction: "in",
        otherId: row.sender_id,
        otherKind: row.sender_kind === "agent" ? "agent" : "human",
        untrusted: row.untrusted !== false,
        createdAt: new Date(String(row.created_at)).toISOString(),
        undelivered: null,
      });
    }
    return out;
  }

  /**
   * Delete whispers past retention (their delivery rows with them), in one
   * statement, at most PRUNE_BATCH per call. A whisper involving someone with an
   * OPEN report is kept until the report is dealt with, so a moderator reviewing
   * it still sees the words around it.
   */
  async prune(retentionDays = WHISPER_RETENTION_DAYS): Promise<number> {
    const { rows } = await this.store.pg.query<{ pruned: number }>(
      `WITH old AS (
         SELECT s.id FROM speech s
          WHERE s.channel = 'whisper'
            AND s.created_at < now() - make_interval(days => $1)
            AND NOT EXISTS (
              SELECT 1 FROM reports r
               WHERE r.status = 'open' AND r.target_id IN (s.sender_id, s.target_id)
            )
          LIMIT $2
       ),
       dels AS (
         DELETE FROM speech_deliveries WHERE speech_id IN (SELECT id FROM old) RETURNING 1
       ),
       gone AS (
         DELETE FROM speech WHERE id IN (SELECT id FROM old) RETURNING 1
       )
       SELECT (SELECT count(*)::int FROM gone) AS pruned, (SELECT count(*) FROM dels) AS _d`,
      [retentionDays, PRUNE_BATCH],
    );
    return rows[0]?.pruned ?? 0;
  }

  /** Prune at most every WHISPER_PRUNE_EVERY_MS per process. For the tick. */
  async maybePrune(now: number = Date.now()): Promise<number> {
    if (now - this.lastPruned < WHISPER_PRUNE_EVERY_MS) return 0;
    this.lastPruned = now;
    return this.prune();
  }
}

function isBlocked(decision: { emit: PolicyDecision; deliveries: Array<{ decision: PolicyDecision }> }): boolean {
  return decision.emit.code === "BLOCKED" || decision.deliveries.some((d) => d.decision.code === "BLOCKED");
}
