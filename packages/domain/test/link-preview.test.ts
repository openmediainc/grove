/**
 * Board link cards (queue #36) reuse #34's SSRF-safe fetcher: text and colours
 * from the page, never HTML or a remote image URL, and every rule of the
 * session (private addresses, redirects into private space, content types)
 * still holds.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLinkPreview } from "../src/site-branding.js";
import { SiteFetchError, isBlockedAddress } from "../src/site-fetch.js";

describe("readLinkPreview", () => {
  let server: http.Server;
  let port = 0;
  const routes = new Map<string, (res: http.ServerResponse) => void>();
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const h = routes.get(req.url ?? "");
      if (h) h(res);
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
  const opts = {
    ports: "any" as const,
    resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
    isBlocked: (ip: string) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
  };
  const html = (body: string) => (res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };

  it("reads title, site name, description and theme colour as text only", async () => {
    routes.set(
      "/post",
      html(`<title>Release notes</title><meta property="og:site_name" content="Moss Labs">
        <meta name="description" content="  What shipped
        this week. &amp; more ">
        <meta property="og:image" content="http://169.254.169.254/latest/meta-data">
        <meta name="theme-color" content="#5eead4">
        <script>document.title = "<img src=x onerror=alert(1)>"</script>`),
    );
    const p = await readLinkPreview(`http://links.test:${port}/post`, opts);
    expect(p).toMatchObject({
      host: "links.test",
      title: "Release notes · Moss Labs",
      description: "What shipped this week. & more",
      themeColour: "#5eead4",
    });
    expect(JSON.stringify(p)).not.toContain("169.254");
    expect(JSON.stringify(p)).not.toContain("onerror");
  });

  it("cuts long titles and descriptions", async () => {
    routes.set("/long", html(`<title>${"word ".repeat(60)}</title><meta name="description" content="${"lorem ipsum ".repeat(60)}">`));
    const p = await readLinkPreview(`http://links.test:${port}/long`, opts);
    expect([...p.title!].length).toBeLessThanOrEqual(120);
    expect([...p.description!].length).toBeLessThanOrEqual(240);
    expect(p.description!.endsWith("…")).toBe(true);
  });

  it("refuses private addresses and redirects into private space, like branding suggestions", async () => {
    await expect(readLinkPreview("http://169.254.169.254/latest/meta-data", opts)).rejects.toMatchObject({ reason: "blocked" });
    await expect(readLinkPreview("http://localhost/", opts)).rejects.toBeInstanceOf(SiteFetchError);
    routes.set("/hop", (res) => {
      res.writeHead(302, { location: "http://10.0.0.5/admin" });
      res.end();
    });
    await expect(readLinkPreview(`http://links.test:${port}/hop`, opts)).rejects.toMatchObject({ reason: "blocked" });
    const rebinding = { ...opts, resolve: async () => [{ address: "10.1.2.3", family: 4 as const }] };
    await expect(readLinkPreview(`http://links.test:${port}/post`, rebinding)).rejects.toMatchObject({ reason: "blocked" });
  });

  it("refuses a page that is not HTML", async () => {
    routes.set("/file.zip", (res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end("PK");
    });
    await expect(readLinkPreview(`http://links.test:${port}/file.zip`, opts)).rejects.toMatchObject({ reason: "content_type" });
  });
});
