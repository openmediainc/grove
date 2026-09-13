import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertTestDatabase,
  databaseName,
  hasTestDatabase,
  isTestDatabase,
  TEST_DB_SUFFIX,
} from "./support/fixtures.js";

/**
 * The guard that stands between `pnpm --filter @grove/domain test` and the live
 * world, tested as a thing in its own right.
 *
 * Two halves, and both have to hold:
 *
 *  1. The PREDICATE refuses a database whose name does not end in `_test`, and
 *     is not fooled by the one thing that made the original guard useless —
 *     DATABASE_URL being SET. Importing @grove/domain loads dotenv as a side
 *     effect, so it is always set, always from the deployed configuration.
 *
 *  2. Every suite that boots against a real database actually USES it. A
 *     predicate nobody calls is decoration; `eviction.test.ts` had the whole
 *     apparatus available to it and simply did not import it, and the way that
 *     stays fixed is a test that reads the directory rather than a convention.
 */

describe("the *_test database guard refuses a live database", () => {
  const LIVE = "postgres://grove:secret@127.0.0.1:5432/grove";
  const TEST = "postgres://grove:secret@127.0.0.1:5432/grove_test";

  it("reads the database NAME, not merely whether a url is present", () => {
    // The exact failure the guard exists for: a url is present, and is wrong.
    expect(hasTestDatabase({ DATABASE_URL: LIVE } as NodeJS.ProcessEnv)).toBe(false);
    expect(hasTestDatabase({ DATABASE_URL: TEST } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasTestDatabase({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("refuses a live url, a url with the suffix in the wrong place, and a non-url", () => {
    expect(isTestDatabase(LIVE)).toBe(false);
    expect(isTestDatabase(TEST)).toBe(true);
    // The suffix has to END the name, not merely appear in it.
    expect(isTestDatabase("postgres://h/grove_test_live")).toBe(false);
    expect(isTestDatabase("postgres://h/_testing")).toBe(false);
    // A host with no database at all is not a test database.
    expect(isTestDatabase("postgres://grove:secret@127.0.0.1:5432/")).toBe(false);
    expect(isTestDatabase("not a url")).toBe(false);
    expect(isTestDatabase("")).toBe(false);
    expect(databaseName(TEST)).toBe(`grove${TEST_DB_SUFFIX}`);
  });

  it("throws on a live database and returns quietly on a test one", () => {
    expect(() => assertTestDatabase(TEST, "run this suite")).not.toThrow();
    expect(() => assertTestDatabase(LIVE, "run this suite")).toThrow(/does not end in "_test"/);
    expect(() => assertTestDatabase(LIVE, "run the eviction suite")).toThrow(
      /Refusing to run the eviction suite/,
    );
  });

  it("names the database but never the url, which carries credentials", () => {
    let message = "";
    try {
      assertTestDatabase(LIVE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"grove"');
    expect(message).not.toContain("secret");
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain(LIVE);
  });
});

/**
 * `handle-collision.test.ts` carries its own inline copy of this predicate
 * (DBT-01) rather than importing the shared one. It is guarded — a duplicate,
 * not a hole — so it is exempt from the import check below and nothing else is.
 * Shrink this set; never grow it.
 */
const OWN_INLINE_GUARD = new Set(["handle-collision.test.ts"]);

describe("every database-backed suite is guarded", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

  /**
   * A suite that imports the migrator boots against a real database and writes
   * to it. Keyed on the IMPORT rather than on a call, so this file's own prose
   * about migrating cannot make it think it is one of them.
   */
  const MIGRATE_IMPORT = /from "\.\.\/src\/migrate\.js"/;
  const dbBacked = files.filter((f) => MIGRATE_IMPORT.test(read(f)));

  it("finds the database-backed suites at all", () => {
    // If this ever drops to zero the checks below would pass vacuously.
    expect(dbBacked.length).toBeGreaterThan(5);
    expect(dbBacked).toContain("eviction.test.ts");
  });

  it.each(dbBacked.filter((f) => !OWN_INLINE_GUARD.has(f)))(
    "%s skips unless DATABASE_URL names a *_test database, and asserts again before booting",
    (file) => {
      const src = read(file);
      // The module-load skip: decides whether the suite runs at all.
      expect(src).toMatch(/hasTestDatabase\(/);
      // The boot-time assertion: loadConfig() can supply a default of its own,
      // so the url actually used is checked a second time.
      expect(src).toMatch(/assertTestDatabase\(\s*config\.databaseUrl/);
    },
  );

  it("keeps the inline-guard exemption honest", () => {
    for (const file of OWN_INLINE_GUARD) {
      expect(files).toContain(file);
      const src = read(file);
      // Whatever shape it takes, it must refuse on the name and refuse at boot.
      expect(src).toContain(TEST_DB_SUFFIX);
      expect(src).toMatch(/refusing|Refusing/);
    }
  });
});
