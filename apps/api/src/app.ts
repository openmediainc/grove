import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { GroveApp } from "@grove/domain";
import { registerRoutes } from "./routes.js";
import { registerRealtime } from "./realtime.js";
import { registerMcp } from "./mcp.js";
import { registerDocs } from "./docs.js";
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
    origin: [grove.store.config.webOrigin, "http://localhost:3000"],
    credentials: true,
  });
  await app.register(websocket);

  app.decorate("grove", grove);

  app.setErrorHandler((err, _req, reply) => sendError(reply, err));

  await registerRoutes(app, grove);
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
