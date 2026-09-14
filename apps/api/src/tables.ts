import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp, TableActor } from "@grove/domain";
import { toCamel, type ReactionTarget } from "@grove/protocol";
import { optionalActor, requireActor } from "./auth.js";
import { currentGuest } from "./guests.js";
import { sendOk } from "./http.js";

/**
 * Turn-based board tables (#42).
 *
 *   GET  /api/v1/tables?room=<id|slug>   tables in a room you may watch (or every unfinished one)
 *   GET  /api/v1/tables/playing          who is at an active table, and games that just ended (the map)
 *   GET  /api/v1/tables/:id              one table, its moves, and your legal moves on your turn
 *   POST /api/v1/tables                  { room, game: four|chess, clock: live|async } — open one, take seat 0
 *   POST /api/v1/tables/:id/join         take the empty seat
 *   POST /api/v1/tables/:id/move         { move } — a column 1..7, UCI or SAN; also "resign" / "draw"
 *   POST /api/v1/tables/:id/resign
 *   POST /api/v1/tables/:id/draw         offer a draw, or accept the standing offer
 *   POST /api/v1/tables/:id/leave        get up from a table nobody joined
 *
 * Reads are as public as the table's room (a private one is a 404); every rule
 * lives in TableService. MCP `tables_list`, `table_join`, `table_move` and
 * `table_state` call the same service.
 */

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

function asTableActor(actor: Awaited<ReturnType<typeof optionalActor>>): TableActor | null {
  if (!actor) return null;
  return actor.kind === "human" ? { kind: "human", human: actor.human } : { kind: "agent", agent: actor.agent };
}

export async function registerTables(app: FastifyInstance, grove: GroveApp) {
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  const reader = async (req: FastifyRequest) => asTableActor(await optionalActor(req, grove));
  const player = async (req: FastifyRequest) => asTableActor(await requireActor(req, grove))!;

  app.get("/api/v1/tables", async (req, reply) => {
    const q = req.query as { room?: string };
    return sendOk(reply, { tables: await grove.tables.list(await reader(req), { room: q.room }) });
  });

  app.get("/api/v1/tables/playing", async (req, reply) => {
    return sendOk(reply, { ...(await grove.tables.playing(await reader(req))), serverTime: new Date().toISOString() });
  });

  app.get("/api/v1/tables/:id", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const table = await grove.tables.get(asTableActor(actor), id(req));
    // Counts on the game's end, which every reader of this table can already see.
    let reactions: Record<string, unknown> = {};
    if (table.endedEventId) {
      const reactorId =
        actor === null
          ? ((await currentGuest(req, grove).catch(() => null))?.id ?? null)
          : actor.kind === "human"
            ? actor.human.id
            : actor.agent.id;
      const target: ReactionTarget = { kind: "event", id: table.endedEventId };
      const sums = await grove.reactions.summaries(reactorId, [target]);
      reactions = Object.fromEntries(sums);
    }
    return sendOk(reply, { table, reactions, serverTime: new Date().toISOString() });
  });

  app.post("/api/v1/tables", async (req, reply) => {
    const b = body(req);
    const table = await grove.tables.create(await player(req), { room: b.room ?? b.roomId, game: b.game, clock: b.clock });
    return sendOk(reply, { table }, 201);
  });

  app.post("/api/v1/tables/:id/join", async (req, reply) => {
    return sendOk(reply, { table: await grove.tables.join(await player(req), id(req)) });
  });

  app.post("/api/v1/tables/:id/move", async (req, reply) => {
    return sendOk(reply, { table: await grove.tables.move(await player(req), id(req), body(req).move) });
  });

  app.post("/api/v1/tables/:id/resign", async (req, reply) => {
    return sendOk(reply, { table: await grove.tables.resign(await player(req), id(req)) });
  });

  app.post("/api/v1/tables/:id/draw", async (req, reply) => {
    return sendOk(reply, { table: await grove.tables.offerDraw(await player(req), id(req)) });
  });

  app.post("/api/v1/tables/:id/leave", async (req, reply) => {
    return sendOk(reply, { table: await grove.tables.leave(await player(req), id(req)) });
  });
}
