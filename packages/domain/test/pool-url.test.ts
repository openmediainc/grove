import { describe, expect, it } from "vitest";
import { poolUrl, sessionUrl } from "../src/db.js";

const SESSION = "postgresql://grove_runtime.abcref:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const TX = "postgresql://grove_runtime.abcref:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

describe("poolUrl", () => {
  it("moves the Supabase session pooler to the transaction pooler on Vercel", () => {
    expect(poolUrl(SESSION, { VERCEL: "1" })).toBe(TX);
  });

  it("keeps the query string and credentials intact", () => {
    expect(poolUrl(`${SESSION}?sslmode=require`, { VERCEL: "1" })).toBe(`${TX}?sslmode=require`);
  });

  it("treats a pooler URL with no port as the session port", () => {
    const noPort = "postgres://u.ref:pw@aws-0-eu-west-2.pooler.supabase.com/postgres";
    expect(poolUrl(noPort, { VERCEL: "1" })).toBe("postgres://u.ref:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres");
  });

  it("rewrites off Vercel only when DATABASE_POOL_MODE=transaction", () => {
    expect(poolUrl(SESSION, {})).toBe(SESSION);
    expect(poolUrl(SESSION, { DATABASE_POOL_MODE: "transaction" })).toBe(TX);
  });

  it("DATABASE_POOL_MODE=session pins session mode even on Vercel", () => {
    expect(poolUrl(SESSION, { VERCEL: "1", DATABASE_POOL_MODE: "session" })).toBe(SESSION);
  });

  it("never touches local, direct or already-transaction URLs", () => {
    const env = { VERCEL: "1", DATABASE_POOL_MODE: "transaction" };
    for (const url of [
      "postgres://grove:grove@localhost:5432/grove_test",
      "postgres://grove:grove@127.0.0.1:5432/grove",
      "postgresql://postgres:pw@db.abcref.supabase.co:5432/postgres",
      "postgresql://u:pw@pooler.supabase.com.evil.example:5432/postgres",
      TX,
    ]) {
      expect(poolUrl(url, env)).toBe(url);
    }
  });

  it("finds the host after the last @ (an unencoded @ in the password)", () => {
    const url = "postgresql://u.ref:a@b@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    expect(poolUrl(url, { VERCEL: "1" })).toBe("postgresql://u.ref:a@b@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  });
});

describe("sessionUrl", () => {
  it("moves a transaction pooler URL back to session mode for LISTEN", () => {
    expect(sessionUrl(TX)).toBe(SESSION);
  });

  it("leaves session and non-pooler URLs alone", () => {
    expect(sessionUrl(SESSION)).toBe(SESSION);
    expect(sessionUrl("postgres://grove:grove@localhost:6543/grove")).toBe("postgres://grove:grove@localhost:6543/grove");
  });
});
