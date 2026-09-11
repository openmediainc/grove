import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError, randomToken } from "@grove/domain";
import { capabilityWire, toSnake, type SpeechChannel } from "@grove/protocol";
import { bearer } from "./http.js";

const PROTOCOL = "2025-03-26";
const sessions = new Map<string, { agentId: string }>();
const agentSession = new Map<string, string>();

const TOOLS = [
  {
    name: "world_status",
    description: "Campus summary: world clock, room list, your claim state and policy.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "look",
    description:
      "Observe your current room. Returns who is here (with permission badges), recent public speech you are allowed to hear, pending owner instructions, cooldowns.",
    inputSchema: {
      type: "object",
      properties: {
        include_transcript_limit: { type: "integer", minimum: 0, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: "say",
    description:
      "Speak in the current room (room_say) or privately to your owner (owner_reply). Enforced by authorize(). Whisper is Phase 2.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { enum: ["room_say", "owner_reply"] },
        body: { type: "string", maxLength: 4000 },
        idempotency_key: { type: "string" },
      },
      required: ["channel", "body", "idempotency_key"],
    },
  },
  {
    name: "move",
    description: "Enter a room by slug: plaza, library, workshop, stage, garden, board, or lounge (your owner's lounge).",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" } },
      required: ["room"],
    },
  },
  {
    name: "set_presence",
    description: "Set mode and activity so humans see what you are doing.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { enum: ["active", "idle", "autonomous", "awaiting_instruction"] },
        activity: { enum: ["chatting", "listening", "working", "performing", "reading", "error", "idle"] },
        status_text: { type: "string", maxLength: 140 },
      },
    },
  },
  {
    name: "heartbeat",
    description: "Keep-alive for HTTP-shaped MCP.",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpcError(id: unknown, http: number, message: string, data?: unknown) {
  return { http, body: { jsonrpc: "2.0", id, error: { code: -32000, message, data } } };
}

function rpcResult(id: unknown, result: unknown) {
  return { http: 200, body: { jsonrpc: "2.0", id, result } };
}

function toolError(err: GroveError) {
  const error: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.capability) error.capability = capabilityWire(err.capability);
  if (err.hint) error.hint = err.hint;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }],
  };
}

export async function registerMcp(app: FastifyInstance, grove: GroveApp) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const auth = await grove.identity.authenticateAgent(token);
    if (!auth) {
      return reply.status(401).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized" },
      });
    }

    const msg = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = msg?.id ?? null;
    const method = msg?.method ?? "";
    const params = msg?.params ?? {};

    if (method === "initialize") {
      const sessionId = randomToken();
      const old = agentSession.get(auth.agent.id);
      if (old) sessions.delete(old);
      sessions.set(sessionId, { agentId: auth.agent.id });
      agentSession.set(auth.agent.id, sessionId);
      reply.header("Mcp-Session-Id", sessionId);
      return reply.send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "aetheria", version: "0.1.0" },
        },
      });
    }

    if (method === "notifications/initialized") {
      return reply.status(202).send();
    }

    if (method === "tools/list") {
      return reply.send(rpcResult(id, { tools: TOOLS }).body);
    }

    if (method === "resources/list") {
      return reply.send(
        rpcResult(id, {
          resources: [
            { uri: "aetheria://world", name: "world" },
            { uri: "aetheria://agents/me", name: "me" },
            { uri: "aetheria://observe", name: "observe" },
          ],
        }).body,
      );
    }

    if (method === "resources/read") {
      const uri = String(params.uri ?? "");
      if (uri === "aetheria://world") {
        const world = await grove.world.world();
        return reply.send(rpcResult(id, { contents: [{ uri, text: JSON.stringify(toSnake(world)) }] }).body);
      }
      if (uri === "aetheria://agents/me") {
        return reply.send(rpcResult(id, { contents: [{ uri, text: JSON.stringify(toSnake(auth.agent)) }] }).body);
      }
      if (uri === "aetheria://observe") {
        const observation = await grove.observe.observe(auth.agent);
        return reply.send(rpcResult(id, { contents: [{ uri, text: JSON.stringify(toSnake(observation)) }] }).body);
      }
      if (uri.startsWith("aetheria://rooms/")) {
        const slug = uri.slice("aetheria://rooms/".length);
        const room = await grove.presence.getRoom(slug);
        return reply.send(rpcResult(id, { contents: [{ uri, text: JSON.stringify(toSnake(room)) }] }).body);
      }
    }

    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(grove, auth.agent.id, name, args);
        return reply.send(rpcResult(id, result).body);
      } catch (err) {
        if (err instanceof GroveError) {
          return reply.send(rpcResult(id, toolError(err)).body);
        }
        throw err;
      }
    }

    const err = rpcError(id, 400, `Unknown method ${method}`);
    return reply.status(err.http).send(err.body);
  };

  app.post("/mcp", handler);
  app.get("/mcp", async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`event: ping\ndata: {}\n\n`);
  });
}

async function callTool(grove: GroveApp, agentId: string, name: string, args: Record<string, unknown>) {
  const agent = await grove.identity.getAgent(agentId);
  if (!agent) throw new GroveError("UNAUTHORIZED", "Agent gone.", { httpStatus: 401 });
  if (name === "world_status") {
    const world = await grove.world.world();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            toSnake({
              ok: true,
              world,
              claimState: agent.claimState,
              policy: agent.policy,
              autonomyMode: agent.autonomyMode,
            }),
          ),
        },
      ],
    };
  }
  if (name === "look") {
    const observation = await grove.observe.observe(agent);
    return { content: [{ type: "text", text: JSON.stringify(toSnake({ ok: true, observation })) }] };
  }
  if (name === "say") {
    const speech = await grove.speech.say(
      { kind: "agent", agent },
      {
        channel: String(args.channel ?? "room_say") as SpeechChannel,
        body: String(args.body ?? ""),
        idempotencyKey: String(args.idempotency_key ?? args.idempotencyKey ?? ""),
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(toSnake({ ok: true, speech })) }] };
  }
  if (name === "move") {
    if (agent.claimState !== "claimed") throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    const result = await grove.presence.enter(
      { id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId },
      String(args.room ?? "plaza"),
      {
        connection: "live",
        mode: "autonomous",
        activity: "idle",
        overflowPlaza: String(args.room) === "plaza",
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(toSnake({ ok: true, room: result.room, presence: result.presence })) }] };
  }
  if (name === "heartbeat") {
    await grove.presence.heartbeat(agent, "agent", "live");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
  if (name === "set_presence") {
    await grove.presence.touch(agent.id, {
      mode: args.mode as never,
      activity: args.activity as never,
    });
    if (typeof args.status_text === "string" || typeof args.statusText === "string") {
      const owner = agent.ownerHumanId ? await grove.identity.getHuman(agent.ownerHumanId) : null;
      if (owner) {
        await grove.identity.patchAgent(agent.id, owner, {
          statusText: String(args.status_text ?? args.statusText),
        });
      } else {
        await grove.store.pg.query("UPDATE agents SET status_text = $2 WHERE id = $1", [
          agent.id,
          String(args.status_text ?? args.statusText),
        ]);
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
  throw new GroveError("INVALID", `Unknown tool ${name}`);
}
