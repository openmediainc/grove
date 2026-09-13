import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { GroveApp } from "@grove/domain";
import { registerRoutes } from "./routes.js";
import { registerRealtime } from "./realtime.js";
import { registerMcp } from "./mcp.js";
import { registerDocs } from "./docs.js";
import { registerPlatform } from "./platform.js";
import { registerModeration } from "./moderation.js";
import { registerEmailHealth } from "./email-health.js";
import { registerOps } from "./ops.js";
import { registerRooms } from "./rooms.js";
import { registerAwn } from "./awn.js";
import { registerUsage } from "./usage.js";
import { registerCards } from "./cards.js";
import { registerFollows } from "./follows.js";
import { registerGuests } from "./guests.js";
import { registerSearch } from "./search.js";
import { registerMessages } from "./messages.js";
import { registerAnalytics } from "./analytics.js";
import { sendError } from "./http.js";

export async function buildApp(grove: GroveApp) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allow = new Set([
        grove.store.config.webOrigin,
        "http://127.0.0.1:3510",
        "http://localhost:3510",
        "https://q-ai.tail735569.ts.net",
        "https://q-ai.tail735569.ts.net:3510",
      ]);
      if (process.env.VERCEL_URL) allow.add(`https://${process.env.VERCEL_URL}`);
      if (allow.has(origin) || origin.endsWith(".vercel.app")) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  });
  await app.register(websocket);

  app.decorate("grove", grove);

  app.setErrorHandler((err, _req, reply) => sendError(reply, err));

  await registerRoutes(app, grove);
  await registerPlatform(app, grove);
  await registerModeration(app, grove);
  await registerEmailHealth(app, grove);
  await registerOps(app, grove);
  await registerRooms(app, grove);
  await registerAwn(app, grove);
  await registerUsage(app, grove);
  await registerCards(app, grove);
  await registerFollows(app, grove);
  await registerGuests(app, grove);
  await registerSearch(app, grove);
  await registerMessages(app, grove);
  await registerAnalytics(app, grove);
  await registerRealtime(app, grove);
  await registerMcp(app, grove);
  await registerDocs(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    grove: GroveApp;
  }
}
