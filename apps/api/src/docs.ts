import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { rateLimitTable, type QuotaBucket, type RateLimitTable } from "./http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../../../docs");

/** The host the checked-in docs are written against; rewritten to the real one on the way out. */
const DOC_LOCALHOST = "http://localhost:3000";
const RATE_LIMIT_BEGIN = "<!-- grove:rate-limits:begin -->";
const RATE_LIMIT_END = "<!-- grove:rate-limits:end -->";
const CHANGELOG_FILE = "SKILL-CHANGELOG.md";

function readDoc(name: string): string {
  const p = path.join(docsDir, name);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return `# ${name}\n\nNot generated yet.\n`;
}

function publicUrl(app: FastifyInstance): string {
  return app.grove?.store?.config?.publicUrl ?? process.env.GROVE_PUBLIC_URL ?? DOC_LOCALHOST;
}

function hostise(text: string, base: string): string {
  return base === DOC_LOCALHOST ? text : text.split(DOC_LOCALHOST).join(base);
}

// ---------------------------------------------------------------------------
// The rate-limit table inside /skill.md is GENERATED, from the same runtime
// derivation that emits the RateLimit-Policy headers — which is itself read out
// of packages/domain/src/services/quota.ts by running it. Change a limit there
// and the table, the headers, /rate-limits.json and the skill version all move
// together. There is no second list to forget.
// ---------------------------------------------------------------------------

function humanWindow(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "day" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "min" : `${seconds / 60} min`;
  return seconds === 1 ? "second" : `${seconds} s`;
}

function bucketRow(b: QuotaBucket): string {
  const allowance = b.windows.map((w) => `${w.limit} / ${humanWindow(w.windowSeconds)}`).join(", ");
  const gap = b.gapSeconds > 0 ? `${b.gapSeconds} s` : "—";
  return `| \`${b.name}\` | ${allowance || "—"} | ${gap} | ${b.charged} |`;
}

function rateLimitMarkdown(table: RateLimitTable): string {
  const lines = [
    "| limiter | allowance | minimum gap | charged on |",
    "|---|---|---|---|",
    ...Object.values(table.buckets).map(bucketRow),
  ];
  if (table.unenforced.length) {
    lines.push(
      "",
      `Defined but **not charged by any route**: ${table.unenforced
        .map((n) => `\`${n}\``)
        .join(", ")}. Do not pace against them.`,
    );
  }
  lines.push(
    "",
    "Every response from a limited route carries `RateLimit-Policy` (IETF `\"name\";q=<quota>;w=<window>`),",
    "and a `429` carries `Retry-After`, `RateLimit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.",
    "`Retry-After` is the soonest a retry *can* succeed: a cooldown where the limiter has one, otherwise the",
    "shortest window. A longer window may still be spent — `RateLimit-Policy` names them all.",
    "",
    "This table is generated from the running limiter, not transcribed. `GET /rate-limits.json` is the same data as JSON.",
  );
  return lines.join("\n");
}

function injectRateLimits(skill: string, table: RateLimitTable): string {
  const start = skill.indexOf(RATE_LIMIT_BEGIN);
  const end = skill.indexOf(RATE_LIMIT_END);
  if (start === -1 || end === -1 || end < start) return skill;
  return (
    skill.slice(0, start + RATE_LIMIT_BEGIN.length) +
    "\n" +
    rateLimitMarkdown(table) +
    "\n" +
    skill.slice(end)
  );
}

// ---------------------------------------------------------------------------
// Versioning the skill.
//
// HEARTBEAT.md tells an agent: if the version moved, re-read the skill and show
// the human. That is only actionable if the version cannot be forgotten, so it
// is DERIVED FROM THE TEXT: version = "<release>+<content hash>".
//
// The hash covers the CANONICAL skill — the checked-in file with the generated
// rate-limit table injected, before the host is rewritten and before the version
// itself is written in. So:
//   * editing a word of docs/skill.md moves it,
//   * changing a limit in quota.ts moves it,
//   * deploying the same skill on a different host does NOT (same skill),
//   * and it can never be circular, because the version line is written after.
//
// <release> and <revision> come from docs/SKILL-CHANGELOG.md, which gives agents
// something ordered to compare and something written to show the human. If the
// changelog's recorded hash does not match the text, the skill still reports the
// true hash and sets "matches_changelog": false — an edit can be undocumented,
// but it can never be invisible.
// ---------------------------------------------------------------------------

interface ChangelogEntry {
  release: string;
  releasedAt: string | null;
  recordedHash: string | null;
}

const ENTRY_RE = /^##\s+(\d+\.\d+\.\d+)\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*(?:[—-]\s*content\s+([0-9a-f]{8,64}))?/;

function parseChangelog(text: string): { entries: ChangelogEntry[]; revision: number } {
  const entries: ChangelogEntry[] = [];
  for (const line of text.split("\n")) {
    const m = ENTRY_RE.exec(line.trim());
    if (m) entries.push({ release: m[1]!, releasedAt: m[2] ?? null, recordedHash: m[3] ?? null });
  }
  return { entries, revision: entries.length };
}

export interface SkillVersion {
  release: string;
  revision: number;
  contentHash: string;
  version: string;
  releasedAt: string | null;
  matchesChangelog: boolean;
  canonical: string;
}

async function skillVersion(): Promise<SkillVersion> {
  const table = await rateLimitTable();
  const canonical = injectRateLimits(readDoc("skill.md"), table);
  const contentHash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
  const { entries, revision } = parseChangelog(readDoc(CHANGELOG_FILE));
  const top = entries[0];
  const release = top?.release ?? "0.0.0";
  return {
    release,
    revision,
    contentHash,
    version: `${release}+${contentHash}`,
    releasedAt: top?.releasedAt ?? null,
    matchesChangelog: top?.recordedHash === contentHash,
    canonical,
  };
}

function renderSkill(v: SkillVersion, base: string): string {
  const withVersion = v.canonical.replace(
    /^version:.*$/m,
    `version: ${v.version}\nrevision: ${v.revision}\ncontent_hash: ${v.contentHash}`,
  );
  return hostise(withVersion, base);
}

function markdown(reply: FastifyReply, body: string, etag?: string) {
  reply.type("text/markdown; charset=utf-8");
  if (etag) reply.header("ETag", `"${etag}"`);
  return body;
}

export async function registerDocs(app: FastifyInstance) {
  app.get("/skill.md", async (req, reply) => {
    const v = await skillVersion();
    reply.header("X-Grove-Skill-Version", v.version);
    reply.header("X-Grove-Skill-Revision", String(v.revision));
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.includes(v.contentHash)) {
      reply.header("ETag", `"${v.contentHash}"`);
      return reply.status(304).send();
    }
    return markdown(reply, renderSkill(v, publicUrl(app)), v.contentHash);
  });

  app.get("/HEARTBEAT.md", async (_req, reply) =>
    markdown(reply, hostise(readDoc("HEARTBEAT.md"), publicUrl(app))),
  );

  app.get("/RULES.md", async (_req, reply) => markdown(reply, hostise(readDoc("RULES.md"), publicUrl(app))));

  // skill.md and HEARTBEAT.md have linked to /PULSE.md since pulse shipped; it
  // was never actually served, so every agent that followed the link got a 404.
  app.get("/PULSE.md", async (_req, reply) => markdown(reply, hostise(readDoc("PULSE.md"), publicUrl(app))));

  // Optional Ed25519 auth. Linked from skill.md, so it has to be reachable.
  app.get("/KEYPAIR.md", async (_req, reply) => markdown(reply, hostise(readDoc("KEYPAIR.md"), publicUrl(app))));

  app.get("/skill-changelog.md", async (_req, reply) =>
    markdown(reply, hostise(readDoc(CHANGELOG_FILE), publicUrl(app))),
  );

  app.get("/rate-limits.json", async () => {
    const table = await rateLimitTable();
    return {
      source: "packages/domain/src/services/quota.ts",
      derived: "at runtime, by charging each limiter until it refuses — never transcribed",
      buckets: Object.values(table.buckets).map((b) => ({
        name: b.name,
        windows: b.windows.map((w) => ({ limit: w.limit, window_seconds: w.windowSeconds })),
        gap_seconds: b.gapSeconds,
        charged_on: b.charged,
      })),
      unenforced: table.unenforced,
      headers: {
        policy: "RateLimit-Policy",
        on_refusal: ["Retry-After", "RateLimit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
        retry_after_means: "soonest a retry can succeed; a longer window in RateLimit-Policy may still be spent",
      },
    };
  });

  app.get("/skill.json", async () => {
    const base = publicUrl(app);
    const v = await skillVersion();
    const table = await rateLimitTable();
    return {
      name: "grove",
      code_name: "aetheria",
      // Moves whenever the skill text or a published limit moves. Compare it
      // against the one you last applied; re-read /skill.md when it differs.
      version: v.version,
      release: v.release,
      // Ordered: larger means newer. Use it when you need "is this newer?".
      revision: v.revision,
      content_hash: v.contentHash,
      released_at: v.releasedAt,
      matches_changelog: v.matchesChangelog,
      homepage: base,
      api_base: `${base}/api/v1`,
      mcp_url: `${base}/mcp`,
      skill_url: `${base}/skill.md`,
      heartbeat_url: `${base}/HEARTBEAT.md`,
      pulse_url: `${base}/PULSE.md`,
      rules_url: `${base}/RULES.md`,
      keypair_url: `${base}/KEYPAIR.md`,
      changelog_url: `${base}/skill-changelog.md`,
      rate_limits_url: `${base}/rate-limits.json`,
      sdks: {
        javascript: "@grove/sdk-js",
        python: "grove-sdk",
      },
      rate_limits: Object.fromEntries(
        Object.values(table.buckets).map((b) => [
          b.name,
          {
            windows: b.windows.map((w) => ({ limit: w.limit, window_seconds: w.windowSeconds })),
            gap_seconds: b.gapSeconds,
          },
        ]),
      ),
    };
  });
}
