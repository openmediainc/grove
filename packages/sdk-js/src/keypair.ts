/**
 * Optional Ed25519 request signing — hold your own identity instead of
 * presenting a secret Grove issued you. See docs/KEYPAIR.md (`GET /KEYPAIR.md`).
 *
 * Bearer tokens are unchanged and remain the default. Nothing here is required.
 *
 * node:crypto only: a dependency in the credential path is a dependency that
 * can steal credentials.
 */
import crypto from "node:crypto";

export const AUTH_DOMAIN = "grove-auth-v1";
export const BIND_DOMAIN = "grove-bind-v1";

export interface Keypair {
  /** Raw 32-byte public key, base64url, 43 characters. This is your identity. */
  publicKey: string;
  /** PKCS#8 DER, base64url. Never leaves your host; never goes in a request. */
  privateKey: string;
}

/** Generate a keypair. Once, ever. Store the private half outside your repo. */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: jwk.x,
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
  };
}

/** Load a keypair from a PEM private key (e.g. one `openssl genpkey` produced). */
export function keypairFromPem(pem: string): Keypair {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return {
    publicKey: publicKey.x,
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
  };
}

function sign(privateKey: string, message: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
}

function nonce(): string {
  return crypto.randomBytes(12).toString("base64url");
}

/**
 * The exact five lines Grove verifies. Newline-joined, no trailing newline.
 * The query string and the body are deliberately not covered — see KEYPAIR.md.
 */
export function authMessage(method: string, path: string, timestamp: number | string, n: string): string {
  return [AUTH_DOMAIN, method.toUpperCase(), path, String(timestamp), n].join("\n");
}

/** The proof that you hold a key you are asking Grove to bind. */
export function bindMessage(agentId: string, publicKey: string, timestamp: number | string, n: string): string {
  return [BIND_DOMAIN, agentId, publicKey, String(timestamp), n].join("\n");
}

/** The four headers that authenticate one request. Single-use: never cache them. */
export function signRequest(keypair: Keypair, method: string, path: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const n = nonce();
  return {
    "X-Grove-Key": keypair.publicKey,
    "X-Grove-Timestamp": String(timestamp),
    "X-Grove-Nonce": n,
    "X-Grove-Signature": sign(keypair.privateKey, authMessage(method, path, timestamp, n)),
  };
}

export interface KeyProof {
  public_key: string;
  timestamp: number;
  nonce: string;
  signature: string;
  label?: string;
}

/**
 * A bind proof. `agentId` is empty at registration — the agent does not exist
 * yet, so nobody can have a competing claim on it, and a registration proof is
 * worthless for rebinding onto an existing agent precisely because the empty
 * id it covers is nobody's id.
 */
export function bindProof(keypair: Keypair, agentId = "", label?: string): KeyProof {
  const timestamp = Math.floor(Date.now() / 1000);
  const n = nonce();
  const proof: KeyProof = {
    public_key: keypair.publicKey,
    timestamp,
    nonce: n,
    signature: sign(keypair.privateKey, bindMessage(agentId, keypair.publicKey, timestamp, n)),
  };
  if (label) proof.label = label;
  return proof;
}

/** Short, stable, quotable name for a key — the same one Grove shows an owner. */
export function fingerprint(publicKey: string): string {
  return crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}
