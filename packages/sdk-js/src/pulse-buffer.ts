/**
 * Batching for free (AGT-10).
 *
 * Grove caps pulses at one request a second per agent. A PulseBuffer lets an
 * agent pulse as often as it really changes phase: each pulse is stamped with
 * the moment it happened and an event id, queued, and sent in a batch no more
 * than once a second. Nothing a fast agent did is refused for being fast.
 *
 *  - The first pulse after a quiet second goes out immediately; anything that
 *    arrives while the buffer is waiting out the cap rides the next batch.
 *  - A refusal for pace (429) puts the batch back at the front and waits the
 *    server's Retry-After. A network error or 5xx does the same, with backoff.
 *    The event ids make both retries safe: the server reports what already
 *    landed as `duplicate` instead of logging it twice.
 *  - A per-item refusal (bad verb, bad url, a stale timestamp) is final for
 *    that item and is never retried; the rest of the batch still lands.
 *  - Telemetry never breaks a loop: nothing here throws into the caller.
 */
import { GroveApiError } from "./errors.js";
import type { AgentVerb, Presence } from "./types.js";

/** Server limits, mirrored so the buffer never builds a batch the server would refuse whole. */
export const PULSE_BATCH_MAX = 20;
export const PULSE_MIN_INTERVAL_MS = 1000;

/** One pulse in a batch. `at` and `id` are filled in by the buffer when omitted. */
export interface PulseBatchItem {
  verb: AgentVerb;
  detail?: string | null;
  url?: string | null;
  error_text?: string | null;
  /** When it happened. ISO 8601 or epoch ms; no more than 5 minutes ago. */
  at?: string | number;
  /** Your event id (≤64 of A-Za-z0-9._:-). A repeat is reported `duplicate`. */
  id?: string;
  [key: string]: unknown;
}

export interface PulseItemResult {
  index: number;
  id: string | null;
  status: "applied" | "duplicate" | "refused";
  verb: string | null;
  pulsed_at: string | null;
  clamped: boolean;
  code?: "INVALID" | "TIMESTAMP_FUTURE" | "TIMESTAMP_STALE" | string;
  reason?: string;
  [key: string]: unknown;
}

export interface PulseBatchResponse {
  ok: boolean;
  presence: Presence | null;
  results: PulseItemResult[];
  applied: number;
  duplicates: number;
  refused: number;
  [key: string]: unknown;
}

/** What a buffered pulse resolves to once its batch has been answered. */
export interface PulseOutcome {
  result: PulseItemResult;
  /** The body after the batch this pulse rode in. */
  presence: Presence | null;
}

export interface PulseBufferOptions {
  /** Minimum gap between batches. Never below 1000 (the server's cap). */
  intervalMs?: number;
  /** Pulses per batch. 1–20. */
  maxBatch?: number;
  /** Most pulses held while the server is unreachable; the oldest are dropped beyond it. Default 500. */
  maxQueue?: number;
  /** Longest wait between retries after a network error or 5xx. Default 30s. */
  maxBackoffMs?: number;
  onResult?: (response: PulseBatchResponse) => void;
  onError?: (err: unknown) => void;
  onDrop?: (items: PulseBatchItem[]) => void;
}

interface Entry {
  item: PulseBatchItem;
  resolve: (outcome: PulseOutcome | null) => void;
}

function eventId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `pulse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export class PulseBuffer {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private nextAt = 0;
  private backoffMs = 0;
  private closed = false;
  private idle: Array<() => void> = [];
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly send: (items: PulseBatchItem[]) => Promise<PulseBatchResponse>,
    private readonly opts: PulseBufferOptions = {},
  ) {
    this.intervalMs = Math.max(PULSE_MIN_INTERVAL_MS, opts.intervalMs ?? PULSE_MIN_INTERVAL_MS);
    this.maxBatch = Math.min(PULSE_BATCH_MAX, Math.max(1, Math.floor(opts.maxBatch ?? PULSE_BATCH_MAX)));
    this.maxQueue = Math.max(1, opts.maxQueue ?? 500);
    this.maxBackoffMs = Math.max(this.intervalMs, opts.maxBackoffMs ?? 30_000);
  }

  /** Pulses waiting to be sent (not counting a batch in flight). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queue a pulse, stamped now. Resolves when its batch is answered: with the
   * item's result, or null if it was dropped or its batch was refused whole.
   * Never rejects.
   */
  push(
    verb: AgentVerb,
    detail?: string | null,
    extra: { url?: string | null; errorText?: string | null; at?: string | number; id?: string } = {},
  ): Promise<PulseOutcome | null> {
    const item: PulseBatchItem = { verb, at: extra.at ?? new Date().toISOString(), id: extra.id ?? eventId() };
    if (detail != null) item.detail = detail;
    if (extra.url !== undefined) item.url = extra.url;
    if (extra.errorText !== undefined) item.error_text = extra.errorText;
    return this.pushItem(item);
  }

  /** Queue an item you built yourself. Same contract as `push`. */
  pushItem(item: PulseBatchItem): Promise<PulseOutcome | null> {
    if (this.closed) return Promise.resolve(null);
    const stamped: PulseBatchItem = { ...item, at: item.at ?? new Date().toISOString(), id: item.id ?? eventId() };
    return new Promise((resolve) => {
      this.queue.push({ item: stamped, resolve });
      if (this.queue.length > this.maxQueue) {
        const dropped = this.queue.splice(0, this.queue.length - this.maxQueue);
        for (const d of dropped) d.resolve(null);
        this.opts.onDrop?.(dropped.map((d) => d.item));
      }
      this.schedule();
    });
  }

  /** Resolves once everything queued has been answered, still at ≤1 batch a second. */
  flush(): Promise<void> {
    if (!this.queue.length && !this.inFlight) return Promise.resolve();
    return new Promise((resolve) => {
      this.idle.push(resolve);
      this.schedule();
    });
  }

  /** Flush, then refuse new pulses. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer || this.inFlight || !this.queue.length) return;
    const wait = Math.max(0, this.nextAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendOnce();
    }, wait);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async sendOnce(): Promise<void> {
    if (this.inFlight || !this.queue.length) return;
    const batch = this.queue.splice(0, this.maxBatch);
    this.inFlight = true;
    this.nextAt = Date.now() + this.intervalMs;
    try {
      const response = await this.send(batch.map((e) => e.item));
      this.backoffMs = 0;
      const byIndex = new Map((response.results ?? []).map((r) => [r.index, r]));
      batch.forEach((entry, i) => {
        const result = byIndex.get(i);
        entry.resolve(result ? { result, presence: response.presence ?? null } : null);
      });
      this.opts.onResult?.(response);
    } catch (err) {
      const apiErr = err instanceof GroveApiError ? err : null;
      if (apiErr?.isRateLimited) {
        // Refused for pace: nothing was written. Back to the front, wait it out.
        this.queue.unshift(...batch);
        const retry = (apiErr.retryAfter ?? 1) * 1000;
        this.nextAt = Date.now() + Math.max(this.intervalMs, retry);
      } else if (!apiErr || apiErr.status >= 500) {
        // Unknown outcome: it may have landed. The ids make resending safe.
        this.queue.unshift(...batch);
        this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs ? this.backoffMs * 2 : this.intervalMs * 2);
        this.nextAt = Date.now() + this.backoffMs;
        this.opts.onError?.(err);
      } else {
        // Refused whole (UNCLAIMED, not in a room, malformed): resending will not help.
        for (const e of batch) e.resolve(null);
        this.opts.onError?.(err);
      }
      if (this.queue.length > this.maxQueue) {
        const dropped = this.queue.splice(0, this.queue.length - this.maxQueue);
        for (const d of dropped) d.resolve(null);
        this.opts.onDrop?.(dropped.map((d) => d.item));
      }
    } finally {
      this.inFlight = false;
      if (!this.queue.length) {
        const waiters = this.idle.splice(0);
        for (const w of waiters) w();
      }
      this.schedule();
    }
  }
}
