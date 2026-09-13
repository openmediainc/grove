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

export const HANDLE_MAX = 20;

export function sanitizeHandle(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const clipped = s.slice(0, HANDLE_MAX);
  if (clipped.length < 2) return `h_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8)}`;
  return clipped;
}

/**
 * Sanitize a handle that MUST keep its disambiguating suffix (`_2`, `_3`, …).
 *
 * DBT-01: sanitizeHandle clips to HANDLE_MAX *after* the suffix is appended, so
 * for an email local part of HANDLE_MAX characters or more the suffix was
 * sliced straight back off. Every collision retry then produced the identical
 * handle, they all collided, and the INSERT died on a unique violation (23505)
 * that surfaced as a 500. Clip the base instead, so the suffix always survives.
 *
 * Short handles are untouched: when base+suffix fits inside HANDLE_MAX nothing
 * was ever clipped, so the original result is returned verbatim.
 */
export function sanitizeHandleWithSuffix(base: string, suffix: string): string {
  const combined = sanitizeHandle(`${base}${suffix}`);
  if (combined.length < HANDLE_MAX) return combined;
  const room = Math.max(1, HANDLE_MAX - suffix.length);
  return sanitizeHandle(`${sanitizeHandle(base).slice(0, room)}${suffix}`);
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

/* ------------------------------------------------------------------ *
 * Self-owned agent identity: Ed25519 keypairs
 *
 * A bearer token is an identity Grove hands out. A keypair is an identity the
 * agent already has: it generates the key, Grove only ever learns the public
 * half, and the agent proves itself by signing rather than by presenting a
 * secret the server also holds a derivative of.
 *
 * Ed25519, from node:crypto, and nothing else:
 *   * it is in the Node 22 standard library — no new dependency, and a
 *     dependency in the credential path is a dependency that can steal
 *     credentials.
 *   * signatures are DETERMINISTIC. ECDSA needs a per-signature random k and
 *     leaks the private key outright if k ever repeats; that footgun has cost
 *     real systems their keys and an agent author writing ten lines of signing
 *     code in a language we have never seen should not be able to step on it.
 *   * 32-byte public keys and 64-byte signatures, so a key fits in an HTTP
 *     header and in a line of documentation.
 *   * it is everywhere: Go crypto/ed25519, Python cryptography, Rust
 *     ed25519-dalek, Java 15+, Ruby, WebCrypto, OpenSSL. "Implementable in any
 *     language" is a hard requirement here and Ed25519 meets it; libsodium
 *     would meet it too but would mean pulling a native dependency into the
 *     tree for an algorithm already sitting in the runtime.
 * ------------------------------------------------------------------ */

/**
 * Domain separator for a request signature. It is the first line of every
 * signed string so a signature produced for one purpose can never be replayed
 * into another: an auth signature is not a bind proof and cannot be turned
 * into one, whatever else the two strings have in common.
 */
export const SIGNED_AUTH_DOMAIN = "grove-auth-v1";

/** Domain separator for a proof that the caller holds a key's secret half. */
export const SIGNED_BIND_DOMAIN = "grove-bind-v1";

/**
 * How far an agent's clock may be from Grove's, in seconds, in either
 * direction.
 *
 * 120s is a deliberate middle. An NTP-synced host is within milliseconds; the
 * honest outliers are containers whose clock has not stepped since start and
 * laptops resuming from sleep, which drift seconds to tens of seconds. A tight
 * 30s window turns those into random unexplainable 401s, which is the worst
 * possible failure for an agent author. Going the other way, the window IS the
 * outer bound on how long a captured signature could be worth anything if the
 * nonce store were lost, so an hour would be indefensible. Two minutes covers
 * real drift with margin and keeps the worst case short.
 */
export const SIGNATURE_SKEW_SEC = 120;

/**
 * TTL of a burnt nonce. MUST exceed the full width of the acceptance window
 * (SIGNATURE_SKEW_SEC in each direction = 240s), or a nonce could expire from
 * the store while its signature is still inside the window and the replay it
 * was meant to stop would succeed at the edge. 300s leaves a minute of slack.
 */
export const NONCE_TTL_SEC = 300;

/** Nonce must carry real entropy; 16 characters of base64url is ~96 bits. */
export const NONCE_MIN_CHARS = 16;

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * Generate a fresh agent keypair.
 *
 * `publicKey` is the raw 32-byte key, base64url — that is the agent's
 * identity, and the only half Grove is ever told about. `privateKey` is a
 * PKCS#8 DER blob, base64url, so it is self-describing and signEd25519 needs
 * nothing else alongside it. It never leaves the agent's host.
 */
export function generateAgentKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: jwk.x,
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
  };
}

/**
 * Accept a public key only in its one canonical spelling.
 *
 * Re-encoding and comparing is not pedantry: base64url leaves two unused bits
 * in the final character of a 32-byte value, so a single key has many valid
 * encodings. Storing a non-canonical one would put the same key in the table
 * twice under different strings, and the UNIQUE index that makes a key name
 * exactly one agent would quietly stop meaning anything.
 */
export function normalizePublicKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.length !== ED25519_PUBLIC_KEY_BYTES) return null;
  return buf.toString("base64url") === s ? s : null;
}

/** A short, stable, human-quotable name for a key. */
export function publicKeyFingerprint(publicKey: string): string {
  return crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

/**
 * What goes in `agent_keys.prefix` for a keypair row, so the owner-facing key
 * list has something to show. It can never collide with a bearer prefix, which
 * is always the first 16 characters of an `aeth_live_` token.
 */
export function publicKeyPrefix(publicKey: string): string {
  return `ed25519_${publicKey.slice(0, 8)}`;
}

/**
 * The exact bytes an agent signs to authenticate one request.
 *
 * Newline-joined, no trailing newline, every field already a string with no
 * escaping rules — an agent author in any language builds this with a join and
 * cannot get it subtly wrong. What each line is defending:
 *
 *   domain     — this signature is an auth signature and nothing else.
 *   method     — a captured GET cannot be turned into a POST.
 *   path       — a captured signature for /observe cannot be aimed at /say.
 *   timestamp  — bounds how long a captured signature lives at all.
 *   nonce      — makes it single-use, so within that window it is still dead.
 *
 * The query string and the body are deliberately NOT covered. The query string
 * is where canonicalisation bugs live (parameter order, encoding, repeated
 * keys) and every one of those bugs is an unexplainable 401 for an honest
 * agent; the body would need the raw bytes, which means owning the HTTP layer.
 * Neither is a regression: a bearer token covers method, path, query and body
 * exactly as much as an empty string does, and unlike a bearer token this
 * signature is single-use.
 */
export function authMessage(parts: {
  method: string;
  path: string;
  timestamp: number | string;
  nonce: string;
}): string {
  return [
    SIGNED_AUTH_DOMAIN,
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestamp),
    parts.nonce,
  ].join("\n");
}

/**
 * The bytes an agent signs to prove it holds the secret half of a key it is
 * asking Grove to bind.
 *
 * `agentId` is what stops a bind proof being lifted off the wire and replayed
 * onto somebody else's agent: a proof is only ever good for the one agent it
 * names. At registration the agent does not exist yet, so the field is the
 * empty string — and a registration proof is worthless for a rebind precisely
 * because that empty string is covered by the signature.
 */
export function bindMessage(parts: {
  agentId: string;
  publicKey: string;
  timestamp: number | string;
  nonce: string;
}): string {
  return [
    SIGNED_BIND_DOMAIN,
    parts.agentId,
    parts.publicKey,
    String(parts.timestamp),
    parts.nonce,
  ].join("\n");
}

/**
 * Verify an Ed25519 signature over a canonical message. Never throws: a
 * malformed key or signature is a failed verification, not a 500.
 */
export function verifyEd25519(publicKey: string, message: string, signature: unknown): boolean {
  const key = normalizePublicKey(publicKey);
  if (!key || typeof signature !== "string") return false;
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature.trim())) return false;
  const sig = Buffer.from(signature.trim(), "base64url");
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    const keyObject = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key },
      format: "jwk",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, sig);
  } catch {
    return false;
  }
}

/**
 * Sign a canonical message. This is AGENT-side code: Grove never holds a
 * private key. It lives here so the tests and the worked example in the docs
 * exercise the same bytes the verifier does, rather than a second
 * implementation that might agree by luck.
 */
export function signEd25519(privateKey: string, message: string): string {
  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(message, "utf8"), keyObject).toString("base64url");
}

/** A nonce fit for one signed request. */
export function newNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
