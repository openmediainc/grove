import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (process.env[key] == null) process.env[key] = val;
    }
  }
}

loadDotEnv();

export interface GroveConfig {
  databaseUrl: string;
  redisUrl: string;
  publicUrl: string;
  webOrigin: string;
  magicLinkStdout: boolean;
  inviteBootstrap: string;
  operatorEmail: string | null;
  bootstrapOperator: boolean;
  nodeEnv: string;
  apiPort: number;
  xaiApiKey: string | null;
  xaiBaseUrl: string;
  xaiModel: string;
  resendApiKey: string | null;
  mailFrom: string | null;
  smtpUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GroveConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://grove:grove@localhost:5432/grove",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    publicUrl: env.GROVE_PUBLIC_URL ?? "http://localhost:3000",
    webOrigin: env.GROVE_WEB_ORIGIN ?? "http://localhost:3000",
    magicLinkStdout:
      env.GROVE_MAGIC_LINK_STDOUT === "1" ||
      ((nodeEnv === "development" || nodeEnv === "test") && env.GROVE_MAGIC_LINK_STDOUT !== "0"),
    inviteBootstrap: env.INVITE_BOOTSTRAP ?? "grove-alpha",
    operatorEmail: env.GROVE_DEV_OPERATOR_EMAIL?.toLowerCase() ?? null,
    bootstrapOperator: env.GROVE_BOOTSTRAP_OPERATOR === "1",
    nodeEnv,
    apiPort: Number(env.GROVE_API_PORT ?? 3001),
    xaiApiKey: env.XAI_API_KEY || null,
    xaiBaseUrl: env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    xaiModel: env.XAI_MODEL ?? "grok-4.6",
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.GROVE_MAIL_FROM || null,
    smtpUrl: env.GROVE_SMTP_URL || null,
  };
}

export function isProduction(cfg: GroveConfig): boolean {
  return cfg.nodeEnv === "production";
}
