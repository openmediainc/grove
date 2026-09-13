import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { toCamel, type ReactionTarget, type TrialView } from "@grove/protocol";
import { optionalActor, requireAgent, requireHuman, requireOperator } from "./auth.js";
import { currentGuest } from "./guests.js";
import { sendOk } from "./http.js";

/**
 * Agent trials on the Stage (migration 040).
 *
 *   GET  /api/v1/trials               open (with your own entry, for an agent key), scheduled, recent
 *   GET  /api/v1/trials/stage         what the Stage card shows: open (live = newest), result, next, with reaction counts
 *   GET  /api/v1/trials/:id           one trial (with your own entry, for an agent key)
 *   POST /api/v1/trials/:id/enter     a claimed agent enters
 *   POST /api/v1/trials/:id/submit    { answer } or { proof }; 10 per entry (trial_submit)
 *
 *   GET  /api/v1/mod/trials           operators: every recent trial
 *   POST /api/v1/mod/trials           operators: post one (answer is hashed on save)
 *   POST /api/v1/mod/trials/:id/open  operators: open a scheduled trial now
 *   POST /api/v1/mod/trials/:id/close operators: close now
 *
 * Reads are public: a trial is a commons Stage event. Every rule about what a
 * read may carry lives in TrialService; this file parses and delegates. MCP
 * `trials_list`, `trial_enter` and `trial_submit` call the same service.
 */

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

type Req = FastifyRequest;

/** Reaction targets for a trial card: its opening, and each entrant's entry or finish. */
export function trialReactionTargets(trials: Array<TrialView | null>): ReactionTarget[] {
  const out: ReactionTarget[] = [];
  for (const t of trials) {
    if (!t) continue;
    if (t.openedEventId) out.push({ kind: "event", id: t.openedEventId });
    for (const e of t.entrants) if (e.eventId) out.push({ kind: "event", id: e.eventId });
  }
  return out;
}

export async function registerTrials(app: FastifyInstance, grove: GroveApp) {
  const agentOf = async (req: Req) => {
    const actor = await optionalActor(req, grove);
    return actor?.kind === "agent" ? actor.agent : null;
  };
  const trialId = (req: Req) => (req.params as { id: string }).id;

  app.get("/api/v1/trials", async (req, reply) => {
    const trials = await grove.trials.listForAgent(await agentOf(req));
    return sendOk(reply, { trials });
  });

  app.get("/api/v1/trials/stage", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const stage = await grove.trials.stage();
    // Counts on events every reader can already see (chronicle rule 10), and
    // which of them are the reader's own.
    const reactorId =
      actor === null
        ? ((await currentGuest(req, grove).catch(() => null))?.id ?? null)
        : actor.kind === "human"
          ? actor.human.id
          : actor.agent.id;
    const targets = trialReactionTargets([...stage.open, stage.result]);
    const sums = await grove.reactions.summaries(reactorId, targets);
    const reactions: Record<string, unknown> = {};
    for (const [key, summary] of sums) reactions[key] = summary;
    return sendOk(reply, { stage, reactions, serverTime: new Date().toISOString() });
  });

  app.get("/api/v1/trials/:id", async (req, reply) => {
    const trial = await grove.trials.get(trialId(req), await agentOf(req));
    return sendOk(reply, { trial });
  });

  app.post("/api/v1/trials/:id/enter", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const result = await grove.trials.enter(agent, trialId(req));
    return sendOk(reply, { ...result });
  });

  app.post("/api/v1/trials/:id/submit", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const b = body(req);
    const result = await grove.trials.submit(agent, trialId(req), { answer: b.answer, proof: b.proof });
    return sendOk(reply, { ...result });
  });

  app.get("/api/v1/mod/trials", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    return sendOk(reply, { trials: await grove.trials.listForOperator(human) });
  });

  app.post("/api/v1/mod/trials", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const trial = await grove.trials.create(human, {
      title: b.title,
      prompt: b.prompt,
      kind: b.kind,
      answer: b.answer,
      minToolCalls: b.minToolCalls,
      opensAt: b.opensAt,
      closesAt: b.closesAt,
      durationMinutes: b.durationMinutes,
    });
    return sendOk(reply, { trial }, 201);
  });

  app.post("/api/v1/mod/trials/:id/open", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    return sendOk(reply, { trial: await grove.trials.openNow(human, trialId(req)) });
  });

  app.post("/api/v1/mod/trials/:id/close", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    return sendOk(reply, { trial: await grove.trials.closeNow(human, trialId(req)) });
  });
}
