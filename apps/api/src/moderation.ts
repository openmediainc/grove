import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp, FreezeFlag, InjectionOutcome, ModDecision } from "@grove/domain";
import { GroveError, isFreezeFlag, isModDecision } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { requireHuman, requireOperator } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * The moderation queue.
 *
 * Lives in its own module rather than in routes.ts so that the operator surface
 * can be read, reviewed and reasoned about in one piece — a mod tool whose
 * authorisation is scattered through a 600-line router is a mod tool nobody
 * audits. Registered from app.ts exactly like registerPlatform/registerRealtime.
 *
 * Paths are /api/v1/mod/*. The older /api/v1/ops/* endpoints in routes.ts still
 * work and are untouched; they are the narrow version of the same thing.
 *
 * EVERY route here is operator-only except GET /api/v1/moderation/warnings,
 * which is deliberately self-serve: an inhabitant is entitled to read the
 * warnings standing against them.
 */

function body(req: FastifyRequest): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

/** Operator gate. requireOperator answers 404, not 403 — the console does not advertise itself. */
async function operator(req: FastifyRequest, grove: GroveApp) {
  const human = await requireHuman(req, grove);
  requireOperator(human);
  return human;
}

function readDecision(value: unknown): ModDecision {
  if (isModDecision(value)) return value;
  throw new GroveError("INVALID", "decision must be one of: dismiss, warn, suspend, freeze.");
}

function readFlag(value: unknown): FreezeFlag {
  if (isFreezeFlag(value)) return value;
  throw new GroveError("INVALID", "Unknown freeze flag.");
}

function readOutcome(value: unknown): InjectionOutcome {
  if (value === "benign" || value === "actioned") return value;
  throw new GroveError("INVALID", "outcome must be benign or actioned.");
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function registerModeration(app: FastifyInstance, grove: GroveApp) {
  // -------------------------------------------------------------------------
  // Triage.
  // -------------------------------------------------------------------------

  /** The queue. `status` is open | resolved | rejected | all. */
  app.get("/api/v1/mod/queue", async (req, reply) => {
    await operator(req, grove);
    const q = req.query as { status?: string; limit?: string };
    const [reports, flags, injection] = await Promise.all([
      grove.moderation.queue({
        status: q.status ?? "open",
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
      grove.moderation.freezeStates(),
      grove.moderation.injectionFlags({ state: "open", limit: 100 }),
    ]);
    // One round trip for the whole console: the queue is useless without the
    // kill switch beside it, and a second fetch is a second chance to be stale.
    return sendOk(reply, {
      reports,
      flags,
      injectionFlags: injection,
      counts: {
        open: reports.filter((r) => r.status === "open").length,
        openInjection: injection.length,
        frozen: flags.filter((f) => f.value).map((f) => f.flag),
      },
    });
  });

  /** One report, with the transcript either side of it. */
  app.get("/api/v1/mod/reports/:id", async (req, reply) => {
    await operator(req, grove);
    const report = await grove.moderation.reportDetail((req.params as { id: string }).id);
    return sendOk(reply, { report });
  });

  /** Decide a report: dismiss | warn | suspend | freeze, with a reason. */
  app.post("/api/v1/mod/reports/:id/decide", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const decision = readDecision(b.decision);
    const result = await grove.moderation.decide(human, (req.params as { id: string }).id, {
      decision,
      reason: optionalText(b.reason),
      ...(b.freezeFlag === undefined ? {} : { freezeFlag: readFlag(b.freezeFlag) }),
    });
    return sendOk(reply, { report: result });
  });

  // -------------------------------------------------------------------------
  // Actor verbs, usable without a report behind them (not every incident
  // arrives as one).
  // -------------------------------------------------------------------------

  app.get("/api/v1/mod/actors/:id", async (req, reply) => {
    await operator(req, grove);
    const id = (req.params as { id: string }).id;
    const [actor, history, warnings] = await Promise.all([
      grove.moderation.describeActor(id),
      grove.moderation.actionsAgainst(id),
      grove.moderation.warningsFor(id),
    ]);
    return sendOk(reply, { actor, history, warnings });
  });

  app.post("/api/v1/mod/actors/:id/warn", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const result = await grove.moderation.warn(
      human,
      (req.params as { id: string }).id,
      optionalText(b.reason),
      { ...(typeof b.reportId === "string" ? { reportId: b.reportId } : {}) },
    );
    return sendOk(reply, result);
  });

  app.post("/api/v1/mod/actors/:id/suspend", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const why = optionalText(b.reason);
    if (!why) throw new GroveError("INVALID", "A suspension needs a reason.");
    const result = await grove.moderation.suspend(
      (req.params as { id: string }).id,
      human.id,
      why,
      typeof b.reportId === "string" ? b.reportId : undefined,
    );
    return sendOk(reply, result);
  });

  app.post("/api/v1/mod/actors/:id/unsuspend", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const why = optionalText(b.reason);
    if (!why) throw new GroveError("INVALID", "Lifting a suspension needs a reason.");
    const result = await grove.moderation.unsuspend((req.params as { id: string }).id, human.id, why);
    return sendOk(reply, result);
  });

  // -------------------------------------------------------------------------
  // Prompt-injection flags: written since day one, read by nobody until now.
  // -------------------------------------------------------------------------

  app.get("/api/v1/mod/injection", async (req, reply) => {
    await operator(req, grove);
    const q = req.query as { state?: string; limit?: string };
    const state = q.state === "reviewed" || q.state === "all" ? q.state : "open";
    const flags = await grove.moderation.injectionFlags({
      state,
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    return sendOk(reply, { flags });
  });

  app.post("/api/v1/mod/injection/:eventId/review", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const result = await grove.moderation.reviewInjectionFlag(
      human,
      (req.params as { eventId: string }).eventId,
      { outcome: readOutcome(b.outcome), note: optionalText(b.note) },
    );
    return sendOk(reply, result);
  });

  // -------------------------------------------------------------------------
  // The kill switch, with its state visible.
  // -------------------------------------------------------------------------

  app.get("/api/v1/mod/flags", async (req, reply) => {
    await operator(req, grove);
    return sendOk(reply, { flags: await grove.moderation.freezeStates() });
  });

  app.post("/api/v1/mod/flags", async (req, reply) => {
    const human = await operator(req, grove);
    const b = body(req);
    const result = await grove.moderation.setFreeze(
      human,
      readFlag(b.flag),
      Boolean(b.value),
      optionalText(b.reason),
    );
    return sendOk(reply, result);
  });

  // -------------------------------------------------------------------------
  // The moderators' own record.
  // -------------------------------------------------------------------------

  app.get("/api/v1/mod/log", async (req, reply) => {
    await operator(req, grove);
    const q = req.query as { limit?: string };
    const entries = await grove.moderation.actionLog(q.limit ? Number(q.limit) : 100);
    return sendOk(reply, { entries });
  });

  // -------------------------------------------------------------------------
  // Self-serve. Not operator-gated on purpose.
  // -------------------------------------------------------------------------

  /**
   * The warnings standing against you and the agents you own. Grove has no
   * human notification channel yet — an agent gets its warning in the mailbox,
   * a human has nowhere to be told — so this is how a warned human can find
   * out at all. Owner-scoped: you may read your own and your agents', nobody
   * else's.
   */
  app.get("/api/v1/moderation/warnings", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agents = await grove.identity.listOwnedAgents(human.id);
    const ids = [human.id, ...agents.map((a) => a.id)];
    const lists = await Promise.all(ids.map((id) => grove.moderation.warningsFor(id)));
    const warnings = lists
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((w) => ({
        // The moderator's identity is not the warned party's business; the
        // reason and the time are.
        createdAt: w.createdAt,
        targetId: String(w.payload.targetId ?? ""),
        reason: w.payload.reason === null || w.payload.reason === undefined ? null : String(w.payload.reason),
      }));
    return sendOk(reply, { warnings });
  });
}
