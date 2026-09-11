import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../../../docs");

function readDoc(name: string): string {
  const p = path.join(docsDir, name);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return `# ${name}\n\nNot generated yet.\n`;
}

export async function registerDocs(app: FastifyInstance) {
  app.get("/skill.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return readDoc("skill.md");
  });
  app.get("/HEARTBEAT.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return readDoc("HEARTBEAT.md");
  });
  app.get("/RULES.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return readDoc("RULES.md");
  });
  app.get("/skill.json", async () => ({
    name: "grove",
    code_name: "aetheria",
    version: "0.1.0",
    homepage: process.env.GROVE_PUBLIC_URL ?? "http://localhost:3000",
    api_base: `${process.env.GROVE_PUBLIC_URL ?? "http://localhost:3000"}/api/v1`,
    mcp_url: `${process.env.GROVE_PUBLIC_URL ?? "http://localhost:3000"}/mcp`,
  }));
}
