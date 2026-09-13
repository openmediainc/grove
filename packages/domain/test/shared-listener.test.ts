import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "../src/db.js";
import { __setListenClientFactory, PgRedis, sharedListener, type ListenClient } from "../src/pg-redis.js";

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  constructor(readonly url: string) {
    super();
  }
  async connect() {}
  async query(sql: string) {
    this.queries.push(sql);
  }
  async end() {
    this.ended = true;
  }
}

const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;

function setup(url: string, idleMs = 60_000) {
  const clients: FakeClient[] = [];
  __setListenClientFactory((cs) => {
    const c = new FakeClient(cs);
    clients.push(c);
    return c;
  }, idleMs);
  const bus = new PgRedis(pool, url);
  return { clients, bus };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
  __setListenClientFactory(null);
});

describe("shared LISTEN connection", () => {
  it("two duplicates on one channel share one client; UNLISTEN only when both quit", async () => {
    const { clients, bus } = setup("postgres://u:p@localhost:5432/a_test");
    const a = bus.duplicate();
    const b = bus.duplicate();
    await a.subscribe("sse:plaza");
    await b.subscribe("sse:plaza");
    expect(clients).toHaveLength(1);
    const listens = clients[0]!.queries.filter((q) => q.startsWith("LISTEN"));
    expect(listens).toHaveLength(1);

    await a.quit();
    expect(clients[0]!.queries.some((q) => q.startsWith("UNLISTEN"))).toBe(false);
    expect(clients[0]!.ended).toBe(false);

    await b.quit();
    expect(clients[0]!.queries.filter((q) => q.startsWith("UNLISTEN"))).toHaveLength(1);
  });

  it("fans a notification out only to instances on that channel", async () => {
    const { clients, bus } = setup("postgres://u:p@localhost:5432/b_test");
    const a = bus.duplicate();
    const b = bus.duplicate();
    await a.subscribe("pubsub:room:1");
    await b.subscribe("pubsub:room:2");
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.on("message", (ch: string, m: string) => gotA.push(`${ch}=${m}`));
    b.on("message", (ch: string, m: string) => gotB.push(`${ch}=${m}`));
    const pgName = clients[0]!.queries[0]!.slice("LISTEN ".length);
    clients[0]!.emit("notification", { channel: pgName, payload: "hi" });
    await flush();
    expect(gotA).toEqual(["pubsub:room:1=hi"]);
    expect(gotB).toEqual([]);
    expect(clients).toHaveLength(1);
  });

  it("unsubscribe of one channel keeps the other subscriptions", async () => {
    const { clients, bus } = setup("postgres://u:p@localhost:5432/c_test");
    const a = bus.duplicate();
    await a.subscribe("x", "y");
    await a.unsubscribe("x");
    expect(clients[0]!.queries.filter((q) => q.startsWith("UNLISTEN"))).toHaveLength(1);
    expect(sharedListener("postgres://u:p@localhost:5432/c_test").channelCount()).toBe(1);
  });

  it("ends the connection after the idle window with no channels, and reopens on demand", async () => {
    vi.useFakeTimers();
    const { clients, bus } = setup("postgres://u:p@localhost:5432/d_test", 1000);
    const a = bus.duplicate();
    await a.subscribe("z");
    await a.quit();
    expect(clients[0]!.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(clients[0]!.ended).toBe(true);
    await a.subscribe("z");
    expect(clients).toHaveLength(2);
  });

  it("a new subscriber inside the idle window cancels the close", async () => {
    vi.useFakeTimers();
    const { clients, bus } = setup("postgres://u:p@localhost:5432/e_test", 1000);
    const a = bus.duplicate();
    await a.subscribe("z");
    await a.quit();
    await vi.advanceTimersByTimeAsync(500);
    await bus.duplicate().subscribe("w");
    await vi.advanceTimersByTimeAsync(2000);
    expect(clients[0]!.ended).toBe(false);
    expect(clients).toHaveLength(1);
  });

  it("reconnects after an error and re-LISTENs every channel", async () => {
    vi.useFakeTimers();
    const { clients, bus } = setup("postgres://u:p@localhost:5432/f_test");
    const a = bus.duplicate();
    await a.subscribe("r1", "r2");
    clients[0]!.emit("error", new Error("terminated"));
    await vi.advanceTimersByTimeAsync(600);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.queries.filter((q) => q.startsWith("LISTEN"))).toHaveLength(2);
  });

  it("uses the session port for LISTEN even given a transaction pooler URL", async () => {
    const { clients, bus } = setup("postgresql://u.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    await bus.duplicate().subscribe("s");
    expect(clients[0]!.url).toContain("pooler.supabase.com:5432/");
  });
});
