import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError, MICROS_PER_USD, normaliseUsageBody } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { requireAgent, requireHuman } from "./auth.js";
import { sendOk } from "./http.js";
import { fetchPaperclipBudgets, type PaperclipBudgets } from "./paperclip.js";

/**
 * Cost burn (AGT-11). Three routes:
 *
 *   POST /api/v1/world/usage       an agent reports what a turn cost
 *   GET  /api/v1/usage             an owner asks what a day cost
 *   PUT  /api/v1/agents/:id/budget an owner sets a monthly budget
 *
 * Every rule about who may read what lives in UsageService, in SQL, once. This
 * file parses and delegates; it decides nothing about visibility.
 */

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

/** Paperclip is another service; its answer is seconds-old at worst. */
const PAPERCLIP_BUDGET_TTL_MS = 30_000;
let paperclipBudgetCache: { at: number; value: PaperclipBudgets } | null = null;

async function paperclipBudgets(): Promise<PaperclipBudgets> {
  const now = Date.now();
  if (paperclipBudgetCache && now - paperclipBudgetCache.at < PAPERCLIP_BUDGET_TTL_MS) {
    return paperclipBudgetCache.value;
  }
  const value = await fetchPaperclipBudgets();
  paperclipBudgetCache = { at: now, value };
  return value;
}

export async function registerUsage(app: FastifyInstance, grove: GroveApp) {
  app.post("/api/v1/world/usage", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot report usage.");
    }
    // Validate before charging the limiter: a malformed report should not cost
    // the agent one of its thirty.
    const reports = normaliseUsageBody(body(req));
    await grove.quota.consumeUsage(agent.id);
    const recorded = await grove.usage.record(agent, reports);
    return sendOk(reply, { recorded, currency: "USD" }, 201);
  });

  app.get("/api/v1/usage", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const q = req.query as { scope?: string; day?: string };
    const day = await grove.usage.day(human, { scope: q.scope, day: q.day });
    // Paperclip has no Grove owner to gate on, so its spend is an operator's.
    const paperclip = human.role === "operator" ? await paperclipBudgets() : null;
    return sendOk(reply, { usage: day, paperclip });
  });

  app.put("/api/v1/agents/:id/budget", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    let micros: number | null;
    if (b.monthlyMicros !== undefined) {
      micros = b.monthlyMicros === null ? null : Number(b.monthlyMicros);
    } else if (b.monthlyUsd !== undefined) {
      micros = b.monthlyUsd === null ? null : Math.round(Number(b.monthlyUsd) * MICROS_PER_USD);
    } else {
      throw new GroveError("INVALID", "Send monthly_usd (or monthly_micros), or null to clear the budget.");
    }
    if (micros !== null && !Number.isFinite(micros)) {
      throw new GroveError("INVALID", "A budget must be a number, or null to clear it.");
    }
    const monthlyMicros = await grove.usage.setBudget(human, (req.params as { id: string }).id, micros);
    return sendOk(reply, { budget: { monthlyMicros } });
  });
}
