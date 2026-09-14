/**
 * Found in the signed-in browser pass (#57): the web client sent
 * `content-type: application/json` on a bodiless DELETE, Fastify refused the
 * empty body, and the error handler turned that into a 500, so Delete on a
 * board post never worked from the page. No database needed.
 */
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installJsonBodyParser, sendError } from "../src/http.js";

describe("JSON bodies", () => {
  const app = Fastify();

  beforeAll(async () => {
    installJsonBodyParser(app);
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    app.delete("/thing", async (req) => ({ ok: true, body: req.body ?? null }));
    app.post("/thing", async (req) => ({ ok: true, body: req.body ?? null }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("an empty body with a JSON content-type is no body", async () => {
    for (const method of ["DELETE", "POST"] as const) {
      const res = await app.inject({ method, url: "/thing", headers: { "content-type": "application/json" } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, body: null });
    }
  });

  it("a real body still parses", async () => {
    const res = await app.inject({ method: "POST", url: "/thing", payload: { a: 1 } });
    expect(res.json()).toEqual({ ok: true, body: { a: 1 } });
  });

  it("malformed JSON and prototype poisoning are 400, not 500", async () => {
    const bad = await app.inject({ method: "POST", url: "/thing", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID");
    const poison = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { "content-type": "application/json" },
      payload: '{"__proto__":{"x":1}}',
    });
    expect(poison.statusCode).toBe(400);
  });
});
