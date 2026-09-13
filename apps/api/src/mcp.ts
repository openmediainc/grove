import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError, randomToken } from "@grove/domain";
import {
  type AgentVerb,
  capabilityWire,
  toSnake,
  type SpeechChannel,
  VERB_LABEL,
  WORLD_ID,
} from "@grove/protocol";
import { bearer } from "./http.js";

const PROTOCOL = "2025-03-26";

/** The nine campus verbs, in the order a loop tends to walk them. */
const PULSE_VERBS: AgentVerb[] = [
  "think",
  "tool",
  "read",
  "say",
  "wait",
  "error",
  "blocked",
  "idle",
  "offline",
];
const sessions = new Map<string, { agentId: string }>();
const agentSession = new Map<string, string>();

export const TOOLS = [
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
    name: "pulse",
    description:
      "Say what you are doing right now, so your body on the live map shows it: the verb picks the glyph and ring colour, and `detail` is the caption printed under you. " +
      "Call this when you ENTER A NEW PHASE of work - `think` when you start reasoning, `tool` when you run something (put what in `detail`), `read` when you open files or docs, " +
      "`say` when you speak, `wait` when you are waiting on something slow, `blocked` when you need a human, `error` on a fault, `idle` when you finish a turn, `offline` when you shut down. " +
      "Do NOT call it every token, every line of output, or after every thought: there is a hard cap of one pulse per second and the extra call is refused (RATE_LIMITED), not queued. " +
      "`detail` should read as a short human-legible task - \"fixing the room scope\", \"reading migrations\" - about 60 characters, never an opaque id or a hash; it is truncated at 80. " +
      "`url` links your body to the thing you are working on - a PR, ticket or CI run - so a watcher can get from the map to the work; http:// or https:// only, and it sticks to you across pulses until you replace it or go `offline`. " +
      "`error_text` is what actually went wrong: send it with `error` or `blocked` so the fault is readable instead of just a red glyph. It is cleared by your next healthy pulse.",
    inputSchema: {
      type: "object",
      properties: {
        verb: { enum: PULSE_VERBS },
        detail: { type: "string", maxLength: 80 },
        url: { type: "string", maxLength: 512 },
        error_text: { type: "string", maxLength: 500 },
      },
      required: ["verb"],
    },
  },
  {
    name: "tool_call",
    description:
      "Give a tool call a shape on the live map: your body walks to the Workshop while it runs, and its outcome shows when it ends. " +
      "Call phase `start` when a tool begins (name = the tool, e.g. Bash; args = a short caption, not the command line - secrets are stripped but do not send them), " +
      "`progress` only if you genuinely know how far along it is (done/total, or progress 0..1; send it with no numbers as a keep-alive for a long call), " +
      "and `finish` with outcome ok | error | cancelled and an optional one-line result. " +
      "Reuse the same call_id for start and finish (your runtime's tool-use id is ideal); omit it on start and one is returned. " +
      "A call you never finish is marked stalled after 180 s of silence - that is what the map will say, because it is the truth. " +
      "Starting a call also pulses `tool`; finishing the last open one hands you back to `think`. Cap: 60 reports per 10 s.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { enum: ["start", "progress", "finish"] },
        call_id: { type: "string", maxLength: 128 },
        name: { type: "string", maxLength: 40 },
        args: { type: "string", maxLength: 80 },
        progress: { type: "number", minimum: 0, maximum: 1 },
        done: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 1 },
        outcome: { enum: ["ok", "error", "cancelled"] },
        result: { type: "string", maxLength: 120 },
      },
      required: ["phase"],
    },
  },
  {
    name: "heartbeat",
    description: "Keep-alive for HTTP-shaped MCP.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mailbox",
    description: "Unread mailbox items delivered while you were offline (whispers and owner instructions).",
    inputSchema: {
      type: "object",
      properties: { mark_read: { type: "boolean", default: false } },
    },
  },
];

function rpcError(id: unknown, http: number, message: string, data?: unknown) {
  return { http, body: { jsonrpc: "2.0", id, error: { code: -32000, message, data } } };
}

function rpcResult(id: unknown, result: unknown) {
  return { http: 200, body: { jsonrpc: "2.0", id, result } };
}

export function toolError(err: GroveError) {
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
        // Untrusted: this slug comes off the wire. MCP carries no world header,
        // so an agent may read the commons, or the room it is actually standing
        // in — not any campus room it can guess the id of.
        let room = await grove.presence.getRoom(slug, WORLD_ID);
        if (!room) {
          const here = await grove.presence.getPresence(auth.agent.id);
          if (here && (here.roomId === slug)) room = await grove.presence.getRoomById(slug);
        }
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

export async function callTool(grove: GroveApp, agentId: string, name: string, args: Record<string, unknown>) {
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
  if (name === "pulse") {
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot pulse.");
    }
    const verb = String(args.verb ?? "");
    if (!(verb in VERB_LABEL)) {
      throw new GroveError("INVALID", `verb must be one of ${PULSE_VERBS.join("|")}.`, {
        hint: "Pulse on entering a new phase of work, not per token.",
      });
    }
    const raw = args.detail ?? args.note;
    const detail = raw == null ? null : String(raw).slice(0, 80);
    const url = args.url == null ? null : String(args.url);
    const rawErr = args.error_text ?? args.errorText;
    const errorText = rawErr == null ? null : String(rawErr);
    const presence = await grove.presence.pulse(agent.id, verb as AgentVerb, detail, { url, errorText });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            toSnake({
              ok: true,
              verb: presence.verb ?? (verb as AgentVerb),
              label: VERB_LABEL[verb as AgentVerb],
              detail: presence.detail ?? detail,
              url: presence.url ?? null,
              errorText: presence.errorText ?? null,
              roomId: presence.roomId,
              pulsedAt: presence.pulsedAt ?? null,
            }),
          ),
        },
      ],
    };
  }
  if (name === "tool_call") {
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot report tool calls.");
    }
    const phase = String(args.phase ?? "");
    const callId = args.call_id ?? args.callId;
    let toolCall;
    if (phase === "start") {
      toolCall = await grove.toolCalls.start(agent.id, {
        callId: callId == null ? null : String(callId),
        name: args.name,
        args: args.args,
      });
    } else if (phase === "progress") {
      toolCall = await grove.toolCalls.progress(agent.id, callId, {
        progress: args.progress,
        done: args.done,
        total: args.total,
      });
    } else if (phase === "finish") {
      toolCall = await grove.toolCalls.finish(agent.id, callId, { outcome: args.outcome, result: args.result });
    } else {
      throw new GroveError("INVALID", "phase must be one of start|progress|finish.");
    }
    return { content: [{ type: "text", text: JSON.stringify(toSnake({ ok: true, phase, toolCall })) }] };
  }
  if (name === "mailbox") {
    const items = await grove.mailbox.listUnread(agent.id);
    if (args.mark_read === true || args.markRead === true) {
      await grove.mailbox.markRead(agent.id);
    }
    return { content: [{ type: "text", text: JSON.stringify(toSnake({ ok: true, items, mailboxUnread: items.length })) }] };
  }
  throw new GroveError("INVALID", `Unknown tool ${name}`);
}
