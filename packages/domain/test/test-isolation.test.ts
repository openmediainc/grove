import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guestIpBucket } from "../src/services/guests.js";
import { clientLimiterKeys, REGISTER_IPS, testClient } from "./support/fixtures.js";

/**
 * Limiter isolation between test files (queue #71), read from the directories
 * rather than trusted to convention.
 *
 * vitest runs files in parallel against one Redis db, and the address-keyed
 * limiters are tight (3 registrations and 10 guest passes per address an hour).
 * Two files sharing an address race each other; a wildcard delete in one file
 * wipes the other's windows mid-run. So: every file owns its address, clears
 * exactly its own keys, and nothing writes a hand-picked address.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIRS = [here, path.resolve(here, "../../../apps/api/test")];

function testFiles(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const dir of TEST_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      // Not this file: it names registry entries and patterns to test the rules.
      if (!name.endsWith(".test.ts") || name === "test-isolation.test.ts") continue;
      const full = path.join(dir, name);
      out.push({ rel: path.relative(path.resolve(here, "../../.."), full), src: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

// Files whose addresses are the subject, not a client: the client-ip parser,
// the guest bucket hash, and the email-health proxy refusal (no limiter).
const ADDRESS_IS_THE_SUBJECT = new Set([
  "apps/api/test/client-ip.test.ts",
  "packages/domain/test/guests.test.ts",
  "apps/api/test/email-health.test.ts",
]);

describe("each test file owns its limiter key space", () => {
  it("scans both suites", () => {
    const files = testFiles().map((f) => f.rel);
    expect(files).toContain("apps/api/test/trials-routes.test.ts");
    expect(files).toContain("packages/domain/test/ops.test.ts");
  });

  it("every registry address is distinct", () => {
    const ips = Object.values(REGISTER_IPS);
    expect(new Set(ips).size).toBe(ips.length);
  });

  it("no registry entry is claimed by two files", () => {
    const owners = new Map<string, string[]>();
    for (const { rel, src } of testFiles()) {
      const names = new Set<string>();
      for (const m of src.matchAll(/REGISTER_IPS\.(\w+)/g)) names.add(m[1]!);
      for (const m of src.matchAll(/testClient\(\s*"(\w+)"\s*\)/g)) names.add(m[1]!);
      for (const n of names) owners.set(n, [...(owners.get(n) ?? []), rel]);
    }
    const shared = [...owners].filter(([, files]) => files.length > 1);
    expect(shared).toEqual([]);
    for (const n of owners.keys()) expect(Object.keys(REGISTER_IPS), `unknown registry name ${n}`).toContain(n);
  });

  it("no file sends a hand-picked x-forwarded-for address", () => {
    const offenders: string[] = [];
    for (const { rel, src } of testFiles()) {
      if (ADDRESS_IS_THE_SUBJECT.has(rel)) continue;
      // A literal or template address after the header name. `client.headers` is the way.
      if (/["']x-forwarded-for["']\s*:\s*[`"'\d]/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("no file clears an address-keyed limiter by pattern", () => {
    const offenders: string[] = [];
    for (const { rel, src } of testFiles()) {
      if (/ratelimit:(ip|guestip):\*|ratelimit:\*|keys\(\s*[`"']ratelimit:(ip|guestip):/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("a file's reset names exactly its own keys", () => {
    const c = testClient("trialsRoutes");
    expect(c.headers).toEqual({ "x-forwarded-for": REGISTER_IPS.trialsRoutes });
    const keys = clientLimiterKeys(c.ip);
    expect(keys.every((k) => !k.includes("*"))).toBe(true);
    expect(keys).toContain(`ratelimit:ip:${c.ip}:register:hour`);
    expect(keys).toContain(`ratelimit:guestip:${guestIpBucket(c.ip)}:issue:hour`);
    // Another file's address shares none of them.
    const other = clientLimiterKeys(REGISTER_IPS.tablesRoutes);
    expect(keys.filter((k) => other.includes(k))).toEqual([]);
  });
});
