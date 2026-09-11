import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { GroveApp } from "@grove/domain";
import { GroveError, randomToken } from "@grove/domain";
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

  const humanSockets = new Map<string, Map<string, WebSocket>>();
  const agentSockets = new Map<string, { token: string; socket: WebSocket }>();

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
      const connToken = randomToken(12);
      const key = `ws:human:${human.id}`;
      await grove.store.redis.sadd(key, connToken);
      await grove.store.redis.expire(key, 7 * 86400);
      const members = await grove.store.redis.smembers(key);
      if (members.length > 2) {
        const kick = members.find((m) => m !== connToken);
        if (kick) {
          await grove.store.redis.srem(key, kick);
          await grove.store.redis.publish(`ws:kick:${human.id}`, kick);
        }
      }
      const local = humanSockets.get(human.id) ?? new Map<string, WebSocket>();
      local.set(connToken, socket);
      humanSockets.set(human.id, local);

      const kickSub = grove.store.redis.duplicate();
      await kickSub.subscribe(`ws:kick:${human.id}`);
      kickSub.on("message", (_ch, message) => {
        if (message === connToken) socket.close(4000, "kicked");
      });

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
        local.delete(connToken);
        void grove.store.redis.srem(key, connToken);
        void sub.quit();
        void kickSub.quit();
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
      const connToken = randomToken(12);
      const prevTok = await grove.store.redis.getset(`ws:agent:${auth.agent.id}`, connToken);
      await grove.store.redis.expire(`ws:agent:${auth.agent.id}`, 7 * 86400);
      if (prevTok && prevTok !== connToken) {
        await grove.store.redis.publish(`ws:kick:${auth.agent.id}`, prevTok);
      }
      const existing = agentSockets.get(auth.agent.id);
      if (existing && existing.socket !== socket) existing.socket.close(4000, "kicked");
      agentSockets.set(auth.agent.id, { token: connToken, socket });

      const kickSub = grove.store.redis.duplicate();
      await kickSub.subscribe(`ws:kick:${auth.agent.id}`);
      kickSub.on("message", (_ch, message) => {
        if (message === connToken) socket.close(4000, "kicked");
      });

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
        const cur = agentSockets.get(auth.agent.id);
        if (cur?.socket === socket) agentSockets.delete(auth.agent.id);
        void grove.store.redis.eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          `ws:agent:${auth.agent.id}`,
          connToken,
        );
        void sub.quit();
        void kickSub.quit();
      });
    })();
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const parts = header.split(";").map((p) => p.trim());
  const hit = parts.find((p) => p.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}
