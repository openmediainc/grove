/**
 * An outbound fetch that cannot be pointed at our own network (queue #34).
 *
 * The one place Glasshouse reads a URL a person typed. It runs on Vercel, where
 * the metadata service and the platform's internals sit one hop away, so every
 * rule here is about refusing to be a proxy into private address space:
 *
 *  - http and https only, default ports only, no credentials in the URL;
 *  - the hostname is resolved HERE, every address it resolves to is checked, and
 *    the connection is pinned to the address that was checked (a custom
 *    `lookup`), so a DNS answer that changes between check and connect
 *    (rebinding) never reaches the socket; the socket's remote address is
 *    checked again once connected;
 *  - redirects are followed by hand, at most MAX_REDIRECTS, and each hop goes
 *    through the same checks;
 *  - one deadline covers the whole session (DNS, connects, every hop, every
 *    body), and bodies are capped as they stream, compressed or not;
 *  - strict content types. Nothing fetched is ever executed: callers get bytes.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

export const SITE_FETCH_USER_AGENT = "GlasshouseBrandingBot/1.0 (+https://glasshouse.rendrr.app/how-it-works)";
export const SITE_FETCH_TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 3;

export type SiteFetchReason =
  | "bad_url"
  | "blocked"
  | "dns"
  | "timeout"
  | "redirects"
  | "status"
  | "content_type"
  | "too_large"
  | "network";

export class SiteFetchError extends Error {
  constructor(
    public reason: SiteFetchReason,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ addresses

function v4Bytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function v6Bytes(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!net.isIPv6(ip)) return null;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    const v4 = v4Bytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = ip.includes("::") ? ip.split("::") : [ip, null];
  const hs = head ? head.split(":") : [];
  const rs = rest ? rest.split(":") : [];
  const groups = rest === null ? hs : [...hs, ...Array(8 - hs.length - rs.length).fill("0"), ...rs];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    out.push((n >> 8) & 255, n & 255);
  }
  if (tail.length) out.splice(12, 4, ...tail);
  return out;
}

function inPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if ((bytes[byte]! & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** Everything that is not ordinary public IPv4 space. */
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. the 169.254.169.254 metadata service
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

/**
 * IPv6 is allow-listed to global unicast (2000::/3), which already excludes
 * ::, ::1, IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, fc00::/7 (unique
 * local), fe80::/10 (link-local) and ff00::/8 (multicast). Inside 2000::/3 these
 * are refused too: ranges that tunnel to an IPv4 address we cannot vet, or are
 * never routed.
 */
const V6_BLOCKED_IN_GLOBAL: Array<[string, number]> = [
  ["2001::", 32], // Teredo (embeds an IPv4 address)
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["3fff::", 20], // documentation
];

/** True for any address a fetch may not connect to, and for anything unparseable. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = v4Bytes(ip);
  if (v4) return V4_BLOCKED.some(([p, bits]) => inPrefix(v4, v4Bytes(p)!, bits));
  const v6 = v6Bytes(ip);
  if (!v6) return true;
  if (!inPrefix(v6, [0x20], 3)) return true;
  return V6_BLOCKED_IN_GLOBAL.some(([p, bits]) => inPrefix(v6, v6Bytes(p)!, bits));
}

// ------------------------------------------------------------------ fetching

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type SiteFetchOptions = {
  /** Whole-session deadline. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** DNS. Tests substitute a fake resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** The address rule. Tests substitute one that lets a loopback test server through. */
  isBlocked?: (ip: string) => boolean;
  /** Ports a URL may name. Default: 80 and 443 only. Tests pass "any". */
  ports?: number[] | "any";
};

export type FetchWant = {
  /** Accept this (lowercased, parameters stripped) content type? */
  accept: (mime: string) => boolean;
  maxBytes: number;
  /** Past maxBytes: keep the first maxBytes (HTML, whose head comes first) or fail (images). */
  overflow: "truncate" | "fail";
  acceptHeader: string;
};

export type FetchedBody = { url: string; mime: string; body: Buffer; truncated: boolean };

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

/**
 * One fetch session: a shared deadline for a page and the images it names.
 * `get` follows redirects itself and applies every rule on every hop.
 */
export class SiteFetchSession {
  private deadline: number;
  private resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  private blocked: (ip: string) => boolean;
  private maxRedirects: number;
  private ports: number[] | "any";

  constructor(opts: SiteFetchOptions = {}) {
    this.deadline = Date.now() + (opts.timeoutMs ?? SITE_FETCH_TIMEOUT_MS);
    this.resolve = opts.resolve ?? systemResolve;
    this.blocked = opts.isBlocked ?? isBlockedAddress;
    this.maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
    this.ports = opts.ports ?? [80, 443];
  }

  remainingMs(): number {
    return this.deadline - Date.now();
  }

  /** Parse and vet a URL without touching the network. */
  checkUrl(raw: string | URL): URL {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      throw new SiteFetchError("bad_url", "That is not a web address.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SiteFetchError("bad_url", "Only http and https addresses can be read.");
    }
    if (url.username || url.password) throw new SiteFetchError("bad_url", "Addresses with a login in them are not read.");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (this.ports !== "any" && !this.ports.includes(port)) {
      throw new SiteFetchError("bad_url", "Only websites on the usual ports can be read.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      throw new SiteFetchError("blocked", "That address is not a public website.");
    }
    if (net.isIP(host) && this.blocked(host)) throw new SiteFetchError("blocked", "That address is not a public website.");
    return url;
  }

  private async withDeadline<T>(p: Promise<T>): Promise<T> {
    const left = this.remainingMs();
    if (left <= 0) throw new SiteFetchError("timeout", "The website took too long to answer.");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SiteFetchError("timeout", "The website took too long to answer.")), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve once, refuse if ANY answer is private, and return the address to pin. */
  private async pin(url: URL): Promise<ResolvedAddress> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literal = net.isIP(host);
    if (literal) {
      if (this.blocked(host)) throw new SiteFetchError("blocked", "That address is not a public website.");
      return { address: host, family: literal === 6 ? 6 : 4 };
    }
    let answers: ResolvedAddress[];
    try {
      answers = await this.withDeadline(this.resolve(host));
    } catch (e) {
      if (e instanceof SiteFetchError) throw e;
      throw new SiteFetchError("dns", "We could not find that website.");
    }
    if (!answers.length) throw new SiteFetchError("dns", "We could not find that website.");
    if (answers.some((a) => this.blocked(a.address))) {
      throw new SiteFetchError("blocked", "That address is not a public website.");
    }
    return answers[0]!;
  }

  async get(raw: string | URL, want: FetchWant): Promise<FetchedBody> {
    let url = this.checkUrl(raw);
    for (let hop = 0; ; hop++) {
      const res = await this.once(url, want);
      if (res.kind === "body") return res.body;
      if (hop >= this.maxRedirects) throw new SiteFetchError("redirects", "The website redirected too many times.");
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        throw new SiteFetchError("bad_url", "The website redirected somewhere unreadable.");
      }
      url = this.checkUrl(next);
    }
  }

  private async once(url: URL, want: FetchWant): Promise<{ kind: "redirect"; location: string } | { kind: "body"; body: FetchedBody }> {
    const pinned = await this.pin(url);
    const left = this.remainingMs();
    if (left <= 0) throw new SiteFetchError("timeout", "The website took too long to answer.");
    const isHttps = url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const blocked = this.blocked;

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const fail = (err: SiteFetchError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        rejectPromise(err);
      };
      const done = (v: { kind: "redirect"; location: string } | { kind: "body"; body: FetchedBody }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(v);
      };

      // The connection goes to the address vetted above, never a fresh DNS answer.
      const lookup = (_h: string, opts: { all?: boolean } | number, cb: (...args: unknown[]) => void) => {
        if (typeof opts === "object" && opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      };

      const options: https.RequestOptions = {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        lookup: lookup as never,
        headers: {
          "user-agent": SITE_FETCH_USER_AGENT,
          accept: want.acceptHeader,
          "accept-encoding": "gzip, deflate, br",
          connection: "close",
        },
      };
      if (isHttps && !net.isIP(host)) options.servername = host;

      const req = (isHttps ? https : http).request(options, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers.location;
          res.destroy();
          if (!location) return fail(new SiteFetchError("status", "The website redirected without saying where."));
          return done({ kind: "redirect", location });
        }
        if (status !== 200) {
          res.destroy();
          return fail(new SiteFetchError("status", `The website answered ${status}.`));
        }
        const mime = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (!want.accept(mime)) {
          res.destroy();
          return fail(new SiteFetchError("content_type", "The website sent something other than what was asked for."));
        }
        const encoding = String(res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
        const length = Number(res.headers["content-length"]);
        if (want.overflow === "fail" && encoding === "identity" && Number.isFinite(length) && length > want.maxBytes) {
          res.destroy();
          return fail(new SiteFetchError("too_large", "That file is too large."));
        }
        let stream: Readable = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
        else if (encoding !== "identity") {
          res.destroy();
          return fail(new SiteFetchError("content_type", "The website used an unreadable encoding."));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () =>
          done({ kind: "body", body: { url: url.toString(), mime, body: Buffer.concat(chunks, size), truncated } });
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (size + chunk.length > want.maxBytes) {
            if (want.overflow === "fail") {
              res.destroy();
              return fail(new SiteFetchError("too_large", "That file is too large."));
            }
            const keep = want.maxBytes - size;
            chunks.push(chunk.subarray(0, keep));
            size += keep;
            truncated = true;
            res.destroy();
            if (stream !== res) stream.destroy();
            return finish();
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", () => fail(new SiteFetchError("network", "The website's answer could not be read.")));
        res.on("error", () => fail(new SiteFetchError("network", "The website's answer could not be read.")));
      });

      req.on("socket", (socket) => {
        // Belt and braces: whatever the socket actually reached must also pass.
        socket.once("connect", () => {
          const remote = socket.remoteAddress;
          if (!remote || blocked(remote.replace(/^::ffff:(?=\d+\.)/, ""))) {
            fail(new SiteFetchError("blocked", "That address is not a public website."));
          }
        });
      });
      req.on("error", () => fail(new SiteFetchError("network", "We could not reach that website.")));
      timer = setTimeout(() => fail(new SiteFetchError("timeout", "The website took too long to answer.")), left);
      req.end();
    });
  }
}
