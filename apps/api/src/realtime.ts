import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import type { SpeechChannel } from "@grove/protocol";
import { COOKIE } from "./http.js";
import { bearer } from "./http.js";

const allowedOrigins = (origin: string | undefined, webOrigin: string) => {
  if (!origin) return false;
  const allow = new Set([
    webOrigin,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
  ]);
  return allow.has(origin);
};

export async function registerRealtime(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/sse/plaza", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": grove.store.config.webOrigin,
    });
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const snap = await grove.world.plazaSnapshot();
    send("state", snap);
    const sub = grove.store.redis.duplicate();
    await sub.subscribe("sse:plaza");
    sub.on("message", (_ch, message) => {
      try {
        const parsed = JSON.parse(message) as { type?: string };
        send(parsed.type ?? "message", parsed);
      } catch {
        send("message", { raw: message });
      }
    });
    const ping = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: {"t":"${new Date().toISOString()}"}\n\n`);
    }, 30000);
    req.raw.on("close", () => {
      clearInterval(ping);
      void sub.unsubscribe("sse:plaza");
      void sub.quit();
    });
  });

  const humanSockets = new Map<string, Set<WebSocketLike>>();
  const agentSockets = new Map<string, WebSocketLike>();

  app.get("/api/v1/ws/human", { websocket: true }, (socket, req) => {
    void (async () => {
      const origin = req.headers.origin;
      if (!allowedOrigins(origin, grove.store.config.webOrigin)) {
        socket.close(1008, "origin");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const ticket = url.searchParams.get("ticket");
      let human = ticket ? await grove.identity.consumeWsTicket(ticket) : null;
      if (!human) {
        const sid = req.cookies?.[COOKIE] ?? cookieValue(req.headers.cookie, COOKIE);
        human = await grove.identity.sessionHuman(sid);
      }
      if (!human) {
        socket.close(1008, "unauthorized");
        return;
      }
      const set = humanSockets.get(human.id) ?? new Set();
      if (set.size >= 2) {
        const oldest = set.values().next().value;
        oldest?.close(4000, "kicked");
        if (oldest) set.delete(oldest);
      }
      set.add(socket);
      humanSockets.set(human.id, set);

      const sub = grove.store.redis.duplicate();
      const p = await grove.presence.getPresence(human.id);
      const channels = [`pubsub:actor:${human.id}`];
      if (p) channels.push(`pubsub:room:${p.roomId}`);
      await sub.subscribe(...channels);
      sub.on("message", (_ch, message) => {
        socket.send(message);
      });

      const ping = setInterval(() => {
        socket.send(JSON.stringify({ type: "pong", server_time: new Date().toISOString() }));
      }, 30000);

      socket.on("message", (raw) => {
        void (async () => {
          try {
            const msg = JSON.parse(String(raw)) as Record<string, unknown>;
            if (msg.type === "ping") {
              socket.send(JSON.stringify({ type: "pong", server_time: new Date().toISOString() }));
              return;
            }
            if (msg.type === "say") {
              const speech = await grove.speech.say(
                { kind: "human", human },
                {
                  channel: String(msg.channel ?? "room_say") as SpeechChannel,
                  body: String(msg.body ?? ""),
                  targetId: msg.target_id ? String(msg.target_id) : null,
                  idempotencyKey: String(msg.idempotency_key ?? ""),
                },
              );
              socket.send(JSON.stringify({ type: "say_ack", speech }));
            }
            if (msg.type === "move") {
              const result = await grove.presence.enter(
                { id: human.id, kind: "human" },
                String(msg.room ?? "plaza"),
                {
                  connection: "live",
                  mode: human.lurk ? "lurk" : "active",
                  activity: "idle",
                  overflowPlaza: String(msg.room) === "plaza",
                },
              );
              await sub.subscribe(`pubsub:room:${result.room.id}`);
              socket.send(JSON.stringify({ type: "moved", room: result.room, presence: result.presence }));
            }
            if (msg.type === "heartbeat") {
              await grove.presence.heartbeat(human, "human", "live");
            }
          } catch (err) {
            const e = err as GroveError;
            socket.send(
              JSON.stringify({
                type: "error",
                error: { code: e.code ?? "INVALID", message: e.message, capability: e.capability },
              }),
            );
          }
        })();
      });

      socket.on("close", () => {
        clearInterval(ping);
        set.delete(socket);
        void sub.quit();
      });
    })();
  });

  app.get("/api/v1/ws/agent", { websocket: true }, (socket, req) => {
    void (async () => {
      const token = bearer(req as never) ?? new URL(req.url, "http://localhost").searchParams.get("access_token") ?? undefined;
      const auth = await grove.identity.authenticateAgent(token);
      if (!auth) {
        socket.close(1008, "unauthorized");
        return;
      }
      const prev = agentSockets.get(auth.agent.id);
      if (prev && prev !== socket) prev.close(4000, "kicked");
      agentSockets.set(auth.agent.id, socket);

      const sub = grove.store.redis.duplicate();
      const p = await grove.presence.getPresence(auth.agent.id);
      const channels = [`pubsub:actor:${auth.agent.id}`];
      if (p) channels.push(`pubsub:room:${p.roomId}`);
      await sub.subscribe(...channels);
      sub.on("message", (_ch, message) => socket.send(message));

      const ping = setInterval(() => {
        socket.send(JSON.stringify({ type: "pong", server_time: new Date().toISOString() }));
      }, 30000);

      socket.on("message", (raw) => {
        void (async () => {
          try {
            const msg = JSON.parse(String(raw)) as Record<string, unknown>;
            const agent = (await grove.identity.getAgent(auth.agent.id)) ?? auth.agent;
            if (msg.type === "ping") {
              socket.send(JSON.stringify({ type: "pong", server_time: new Date().toISOString() }));
              return;
            }
            if (msg.type === "heartbeat") {
              await grove.presence.heartbeat(agent, "agent", "live");
              socket.send(JSON.stringify({ type: "heartbeat_ack" }));
            }
            if (msg.type === "say") {
              const speech = await grove.speech.say(
                { kind: "agent", agent },
                {
                  channel: String(msg.channel ?? "room_say") as SpeechChannel,
                  body: String(msg.body ?? ""),
                  targetId: msg.target_id ? String(msg.target_id) : null,
                  idempotencyKey: String(msg.idempotency_key ?? ""),
                },
              );
              socket.send(JSON.stringify({ type: "say_ack", speech }));
            }
            if (msg.type === "move") {
              if (agent.claimState !== "claimed") throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
              const result = await grove.presence.enter(
                { id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId },
                String(msg.room ?? "plaza"),
                { connection: "live", mode: "autonomous", activity: "idle", overflowPlaza: String(msg.room) === "plaza" },
              );
              await sub.subscribe(`pubsub:room:${result.room.id}`);
              socket.send(JSON.stringify({ type: "moved", room: result.room, presence: result.presence }));
            }
            if (msg.type === "ack_instruction") {
              await grove.world.ackInstruction(agent, String(msg.id ?? ""));
              socket.send(JSON.stringify({ type: "ack_ok", id: msg.id }));
            }
          } catch (err) {
            const e = err as GroveError;
            socket.send(
              JSON.stringify({
                type: "error",
                error: { code: e.code ?? "INVALID", message: e.message, capability: e.capability },
              }),
            );
          }
        })();
      });

      socket.on("close", () => {
        clearInterval(ping);
        if (agentSockets.get(auth.agent.id) === socket) agentSockets.delete(auth.agent.id);
        void sub.quit();
      });
    })();
  });
}

type WebSocketLike = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (ev: string, cb: (...args: never[]) => void) => void;
};

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const parts = header.split(";").map((p) => p.trim());
  const hit = parts.find((p) => p.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}
