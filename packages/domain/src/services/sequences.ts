import { SEQUENCE_ID_RE, validateSequence, type Human, type Sequence } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { QuotaService } from "./quota.js";

/**
 * Stored cinematic sequences (queue #39, migration 042).
 *
 * Only a sequence too long to ride in a link lands here. Records are public,
 * unlisted and immutable: saved once by a signed-in person, read by id by
 * anyone, never listed, never edited. The body is validated with the same
 * @grove/protocol function the map plays with, so what is stored is exactly
 * what plays. Nothing about who saved it is ever returned.
 */
export class SequenceService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
  ) {}

  async save(human: Human, raw: unknown): Promise<{ id: string; sequence: Sequence }> {
    // Validate before charging the limiter: a malformed body should not cost a save.
    const r = validateSequence(raw);
    if (!r.ok) throw new GroveError("INVALID", r.message);
    await this.quota.consumeSequenceSave(human.id);
    const id = newId("sequence");
    await this.store.pg.query(`INSERT INTO camera_sequences (id, body, created_by) VALUES ($1, $2::jsonb, $3)`, [
      id,
      JSON.stringify(r.sequence),
      human.id,
    ]);
    return { id, sequence: r.sequence };
  }

  /** A stored sequence by id, re-validated on the way out; anything else is 404. */
  async get(id: string): Promise<Sequence> {
    const notFound = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    if (!SEQUENCE_ID_RE.test(id)) throw notFound();
    const { rows } = await this.store.pg.query<{ body: unknown }>(`SELECT body FROM camera_sequences WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound();
    const r = validateSequence(rows[0].body);
    if (!r.ok) throw notFound();
    return r.sequence;
  }
}
