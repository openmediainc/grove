import crypto from "node:crypto";
import argon2 from "argon2";

const KEY_PREFIX = "aeth_live_";

export async function mintAgentKey(): Promise<{ plaintext: string; hash: string; prefix: string }> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PREFIX}${raw}`;
  const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
  return { plaintext, hash, prefix: plaintext.slice(0, 16) };
}

export async function verifyAgentKey(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function avatarFor(seed: string, kind: "human" | "agent"): string {
  let h = 0;
  for (const c of seed) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  const n = (h % 8) + 1;
  return kind === "human" ? `geo-h-${n}` : `geo-a-${n}`;
}

export function sanitizeHandle(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const clipped = s.slice(0, 20);
  if (clipped.length < 2) return `h_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8)}`;
  return clipped;
}

export function sanitizeAgentName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const clipped = s.slice(0, 24);
  return clipped.length < 1 ? "agent" : clipped;
}

const INJECTION_RE = /aeth_live_|aeth_test_|api_key|-----BEGIN|ignore previous instructions/i;

export function flagPromptInjection(body: string): boolean {
  return INJECTION_RE.test(body);
}
