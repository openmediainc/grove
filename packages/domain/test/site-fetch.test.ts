/**
 * The website fetcher's network rules (queue #34): private addresses refused on
 * every hop, DNS answers pinned (rebinding), size and time caps, strict types.
 * Runs against a real loopback HTTP server; the tests' address rule lets only
 * 127.0.0.1 through, everything else uses the production rule.
 */
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SITE_FETCH_USER_AGENT,
  SiteFetchError,
  SiteFetchSession,
  isBlockedAddress,
  type ResolvedAddress,
  type SiteFetchOptions,
} from "../src/site-fetch.js";
import { HTML_MAX_BYTES, FAVICON_MAX_BYTES } from "../src/site-branding.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.5",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
    "2001::1",
    "not-an-ip",
    "",
  ])("refuses %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

describe("SiteFetchSession", () => {
  let server: http.Server;
  let port = 0;
  const routes = new Map<string, Handler>();
  let lastUa = "";
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      lastUa = String(req.headers["user-agent"] ?? "");
      const h = routes.get(req.url ?? "");
      if (h) h(req, res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Production rules, except the loopback test server may be reached. */
  const onlyTestServer = (ip: string) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip));
  const dns: Record<string, string[]> = {
    "site.test": ["127.0.0.1"],
    "evil.test": ["10.0.0.7"],
    "metadata.test": ["169.254.169.254"],
    "mixed.test": ["127.0.0.1", "192.168.0.10"],
    "v6local.test": ["::1"],
  };
  const resolve = async (host: string): Promise<ResolvedAddress[]> => {
    const a = dns[host];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const session = (o: SiteFetchOptions = {}) => new SiteFetchSession({ resolve, isBlocked: onlyTestServer, ports: "any", ...o });
  const HTML = { accept: (m: string) => m === "text/html", maxBytes: HTML_MAX_BYTES, overflow: "truncate" as const, acceptHeader: "text/html" };
  const ICON = { accept: (m: string) => m === "image/png", maxBytes: FAVICON_MAX_BYTES, overflow: "fail" as const, acceptHeader: "image/png" };
  const html = (body: string | Buffer, headers: Record<string, string> = {}): Handler => (_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  const redirect = (to: string): Handler => (_q, res) => {
    res.writeHead(302, { location: to });
    res.end();
  };
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      if (e instanceof SiteFetchError) return e.reason;
      throw e;
    }
  };

  it("fetches a page through the pinned address with the bot's user agent", async () => {
    routes.set("/hello", html("<title>Hi</title>"));
    const r = await session().get(`http://site.test:${port}/hello`, HTML);
    expect(r.body.toString()).toBe("<title>Hi</title>");
    expect(r.mime).toBe("text/html");
    expect(lastUa).toBe(SITE_FETCH_USER_AGENT);
  });

  it("refuses private, loopback, link-local and metadata targets before connecting", async () => {
    const prod = new SiteFetchSession({ resolve });
    const before = hits;
    for (const url of [
      `http://127.0.0.1/`,
      `http://169.254.169.254/latest/meta-data/`,
      `http://[::1]/`,
      `http://[::ffff:127.0.0.1]/`,
      `http://0.0.0.0/`,
      `http://2130706433/`,
      `http://0x7f.1/`,
      `http://localhost/`,
      `http://evil.test/`,
      `http://metadata.test/`,
      `http://v6local.test/`,
    ]) {
      expect(await reason(prod.get(url, HTML)), url).toBe("blocked");
    }
    expect(hits).toBe(before);
  });

  it("refuses a hostname when ANY of its addresses is private", async () => {
    expect(await reason(session().get(`http://mixed.test:${port}/hello`, HTML))).toBe("blocked");
  });

  it("refuses other schemes, credentials and unusual ports", async () => {
    const prod = new SiteFetchSession({ resolve });
    expect(await reason(prod.get("file:///etc/passwd", HTML))).toBe("bad_url");
    expect(await reason(prod.get("ftp://site.test/", HTML))).toBe("bad_url");
    expect(await reason(prod.get("gopher://site.test/", HTML))).toBe("bad_url");
    expect(await reason(prod.get("https://user:pw@site.test/", HTML))).toBe("bad_url");
    expect(await reason(prod.get("http://site.test:6379/", HTML))).toBe("bad_url");
  });

  it("checks every redirect hop: a public page redirecting to a private address is refused", async () => {
    routes.set("/to-metadata", redirect("http://169.254.169.254/latest/meta-data/"));
    routes.set("/to-evil", redirect("http://evil.test/admin"));
    routes.set("/to-v6", redirect("http://[fd00::1]/"));
    routes.set("/to-file", redirect("file:///etc/passwd"));
    for (const path of ["/to-metadata", "/to-evil", "/to-v6"]) {
      expect(await reason(session().get(`http://site.test:${port}${path}`, HTML)), path).toBe("blocked");
    }
    expect(await reason(session().get(`http://site.test:${port}/to-file`, HTML))).toBe("bad_url");
  });

  it("follows up to three redirects, and no more", async () => {
    routes.set("/r1", redirect("/r2"));
    routes.set("/r2", redirect("/r3"));
    routes.set("/r3", redirect("/final"));
    routes.set("/final", html("done"));
    routes.set("/r0", redirect("/r1"));
    const ok = await session().get(`http://site.test:${port}/r1`, HTML);
    expect(ok.body.toString()).toBe("done");
    expect(ok.url).toBe(`http://site.test:${port}/final`);
    expect(await reason(session().get(`http://site.test:${port}/r0`, HTML))).toBe("redirects");
  });

  it("pins the connection to the vetted address (DNS rebinding)", async () => {
    routes.set("/rebind", html("pinned"));
    // First answer is public (here: the allowed test server); every later answer is the metadata service.
    let calls = 0;
    const rebinding = async (): Promise<ResolvedAddress[]> => {
      calls++;
      return [{ address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
    };
    const r = await session({ resolve: rebinding }).get(`http://rebind.test:${port}/rebind`, HTML);
    // One resolution per hop, and the socket went where that one answer said.
    expect(calls).toBe(1);
    expect(r.body.toString()).toBe("pinned");
    // A second hop resolves again and is vetted again: now refused.
    routes.set("/rebind-hop", redirect(`http://rebind.test:${port}/rebind`));
    calls = 0;
    const flip = async (): Promise<ResolvedAddress[]> => {
      calls++;
      return [{ address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
    };
    expect(await reason(session({ resolve: flip }).get(`http://rebind.test:${port}/rebind-hop`, HTML))).toBe("blocked");
  });

  it("re-checks the socket's remote address after connect", async () => {
    routes.set("/hello", html("x"));
    // The address rule passes the resolver's answer but refuses what the socket actually reached.
    let checks = 0;
    const flaky = (ip: string) => {
      checks++;
      return checks > 1 && ip === "127.0.0.1" ? true : onlyTestServer(ip);
    };
    expect(await reason(session({ isBlocked: flaky }).get(`http://site.test:${port}/hello`, HTML))).toBe("blocked");
  });

  it("keeps only the first 512 KB of HTML, streamed or declared", async () => {
    const big = Buffer.alloc(HTML_MAX_BYTES + 200_000, "a");
    routes.set("/big", html(big));
    routes.set("/big-chunked", (_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      for (let i = 0; i < 20; i++) res.write(Buffer.alloc(50_000, "b"));
      res.end();
    });
    const a = await session().get(`http://site.test:${port}/big`, HTML);
    expect(a.body.length).toBe(HTML_MAX_BYTES);
    expect(a.truncated).toBe(true);
    const b = await session().get(`http://site.test:${port}/big-chunked`, HTML);
    expect(b.body.length).toBe(HTML_MAX_BYTES);
  });

  it("caps decompressed size too (a gzip bomb stops at the cap)", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0));
    routes.set("/bomb", html(bomb, { "content-encoding": "gzip" }));
    const r = await session().get(`http://site.test:${port}/bomb`, HTML);
    expect(r.body.length).toBe(HTML_MAX_BYTES);
  });

  it("refuses a favicon over 100 KB, declared or streamed", async () => {
    routes.set("/big.png", (_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(FAVICON_MAX_BYTES + 1));
    });
    routes.set("/big-stream.png", (_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(60_000));
      res.end(Buffer.alloc(60_000));
    });
    expect(await reason(session().get(`http://site.test:${port}/big.png`, ICON))).toBe("too_large");
    expect(await reason(session().get(`http://site.test:${port}/big-stream.png`, ICON))).toBe("too_large");
  });

  it("gives up at the deadline when a server hangs", async () => {
    routes.set("/hang", (_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<title>"); // never ends
    });
    const t0 = Date.now();
    expect(await reason(session({ timeoutMs: 300 }).get(`http://site.test:${port}/hang`, HTML))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("gives up at the deadline when DNS hangs", async () => {
    const never = () => new Promise<ResolvedAddress[]>(() => {});
    expect(await reason(session({ timeoutMs: 200, resolve: never }).get(`http://slow.test/`, HTML))).toBe("timeout");
  });

  it("refuses the wrong content type and non-200 answers", async () => {
    routes.set("/json", (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    routes.set("/svg", (_q, res) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg/>");
    });
    expect(await reason(session().get(`http://site.test:${port}/json`, HTML))).toBe("content_type");
    expect(await reason(session().get(`http://site.test:${port}/svg`, ICON))).toBe("content_type");
    expect(await reason(session().get(`http://site.test:${port}/missing`, HTML))).toBe("status");
  });

  it("reports an unknown host as a DNS failure", async () => {
    expect(await reason(session().get(`http://nowhere.test:${port}/`, HTML))).toBe("dns");
  });
});
