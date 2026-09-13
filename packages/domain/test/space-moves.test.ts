/**
 * Transfer & relocate (queue #35, migration 039). The properties that matter:
 *  - an offer changes nothing until the recipient accepts; the holder can
 *    withdraw it; it runs out after a week; only one waits per space;
 *  - accepting swaps the holder atomically, keeps (or drops, by choice) the old
 *    holder's membership, and leaves branding with the space;
 *  - an org transfer goes to a bound org's owner and marks the org;
 *  - a move takes a free plot under a lock, refuses a taken one, the commons,
 *    and a second move within a week;
 *  - both acts are audited, and a private space's audit rows reach members only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { WORLD_ID } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("space transfer & relocate", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the space moves suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function space(owner: Awaited<ReturnType<typeof newHuman>>, preset: "private" | "public_write" = "public_write") {
    const t = tag();
    const w = await grove.campus.createWorld(owner, { name: `Move Yard ${t}`, slug: `moveyard-${t}`, preset });
    fixtures.trackWorld(w.id);
    return w;
  }

  async function code(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GroveError);
    return (err as GroveError).code;
  }

  const viewer = (humanId: string | null) => ({ humanId, isOperator: false });

  it("offers, withdraws, re-offers and hands over on accept; the old holder stays a member", async () => {
    const owner = await newHuman("mv-owner");
    const heir = await newHuman("mv-heir");
    const outsider = await newHuman("mv-out");
    const w = await space(owner);
    await grove.branding.setSpaceBranding(owner, w.id, { accent: "violet" });

    // Only a member can be offered the space; the slug must be typed.
    expect(await code(grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug }))).toBe("INVALID");
    await grove.campus.addMember(w.id, heir.id);
    expect(await code(grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: "nope" }))).toBe("INVALID");
    // Not the holder: the same 404 as no space at all.
    expect(await code(grove.spaceMoves.offerTransfer(heir, w.id, { toHumanId: owner.id, confirm: w.slug }))).toBe("NOT_FOUND");
    expect(await code(grove.spaceMoves.transferState(outsider, w.id))).toBe("NOT_FOUND");

    const offer = await grove.spaceMoves.offerTransfer(owner, w.id, { toHandle: `@${heir.handle}`, confirm: ` ${w.slug} ` });
    expect(offer.status).toBe("pending");
    expect(offer.to.humanId).toBe(heir.id);
    // One pending offer per space.
    expect(await code(grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug }))).toBe("CONFLICT");
    // Nothing changed hands yet.
    expect((await grove.campus.requireWorld(w.id)).ownerHumanId).toBe(owner.id);
    expect((await grove.spaceMoves.incoming(heir.id)).map((t) => t.id)).toContain(offer.id);

    const cancelled = await grove.spaceMoves.cancelTransfer(owner, w.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await grove.spaceMoves.incoming(heir.id)).map((t) => t.id)).not.toContain(offer.id);
    expect(await code(grove.spaceMoves.answer(heir, offer.id, "accept"))).toBe("CONFLICT");

    const again = await grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug });
    // Somebody else cannot answer it, and neither can the holder.
    expect(await code(grove.spaceMoves.answer(outsider, again.id, "accept"))).toBe("NOT_FOUND");
    expect(await code(grove.spaceMoves.answer(owner, again.id, "accept"))).toBe("NOT_FOUND");

    const accepted = await grove.spaceMoves.answer(heir, again.id, "accept");
    expect(accepted.status).toBe("accepted");
    const after = await grove.campus.requireWorld(w.id);
    expect(after.ownerHumanId).toBe(heir.id);
    expect(after.plotIndex).toBe(w.plotIndex);
    expect(await grove.campus.isMember(w.id, owner.id)).toBe(true);
    expect((await grove.branding.ofWorld(w.id))?.accent).toBe("#c4b5fd");
    // The old holder is now just a member: no more Manage acts.
    expect(await code(grove.spaceMoves.relocationPlan(owner, w.id))).toBe("NOT_FOUND");

    const { rows } = await pg.query(
      `SELECT id, payload FROM world_events WHERE type = 'space.transferred' AND payload->>'transferId' = $1`,
      [again.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ from: owner.id, to: heir.id, worldId: w.id });
    const entry = await grove.chronicle.entryById(viewer(outsider.id), String(rows[0].id));
    expect(entry?.summary).toContain(heir.handle);
    const log = await grove.moderation.actionLog(500);
    expect(log.some((e) => e.id === String(rows[0].id))).toBe(true);
  });

  it("declines, expires after a week, and lets the holder leave on accept", async () => {
    const owner = await newHuman("mv-dec");
    const heir = await newHuman("mv-dec-heir");
    const w = await space(owner);
    await grove.campus.addMember(w.id, heir.id);

    const first = await grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug });
    expect((await grove.spaceMoves.answer(heir, first.id, "decline")).status).toBe("declined");
    expect((await grove.campus.requireWorld(w.id)).ownerHumanId).toBe(owner.id);
    expect((await grove.spaceMoves.transferState(owner, w.id)).last?.status).toBe("declined");

    const stale = await grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug });
    await pg.query(`UPDATE space_transfers SET expires_at = now() - interval '1 second' WHERE id = $1`, [stale.id]);
    expect((await grove.spaceMoves.incoming(heir.id)).map((t) => t.id)).not.toContain(stale.id);
    expect(await code(grove.spaceMoves.answer(heir, stale.id, "accept"))).toBe("CONFLICT");
    const state = await grove.spaceMoves.transferState(owner, w.id);
    expect(state.pending).toBeNull();
    expect(state.last?.status).toBe("expired");

    // An expired offer does not block a new one.
    const leaving = await grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug, leave: true });
    await grove.spaceMoves.answer(heir, leaving.id, "accept");
    expect((await grove.campus.requireWorld(w.id)).ownerHumanId).toBe(heir.id);
    expect(await grove.campus.isMember(w.id, owner.id)).toBe(false);
  });

  it("withdraws an offer whose recipient left before accepting", async () => {
    const owner = await newHuman("mv-gone");
    const heir = await newHuman("mv-gone-heir");
    const w = await space(owner);
    await grove.campus.addMember(w.id, heir.id);
    const offer = await grove.spaceMoves.offerTransfer(owner, w.id, { toHumanId: heir.id, confirm: w.slug });
    await pg.query(`DELETE FROM world_members WHERE world_id = $1 AND human_id = $2`, [w.id, heir.id]);
    expect(await code(grove.spaceMoves.answer(heir, offer.id, "accept"))).toBe("CONFLICT");
    expect((await grove.campus.requireWorld(w.id)).ownerHumanId).toBe(owner.id);
    expect((await grove.spaceMoves.transferState(owner, w.id)).last?.status).toBe("cancelled");
  });

  it("hands a space to a bound org, accepted by the org's owner", async () => {
    const owner = await newHuman("mv-org");
    const orgOwner = await newHuman("mv-orgown");
    const w = await space(owner);
    const org = await grove.campus.createOrg(orgOwner, { name: `Move Org ${tag()}` });
    fixtures.trackOrg(org.id);
    // Not bound yet: refused.
    expect(await code(grove.spaceMoves.offerTransfer(owner, w.id, { toOrgId: org.id, confirm: w.slug }))).toBe("INVALID");
    await pg.query(`INSERT INTO world_orgs (world_id, org_id) VALUES ($1,$2)`, [w.id, org.id]);
    const cands = await grove.spaceMoves.candidates(owner, w.id);
    expect(cands.orgs.map((o) => o.id)).toContain(org.id);

    const offer = await grove.spaceMoves.offerTransfer(owner, w.id, { toOrgId: org.slug, confirm: w.slug });
    expect(offer.toOrg?.id).toBe(org.id);
    expect(offer.to.humanId).toBe(orgOwner.id);
    await grove.spaceMoves.answer(orgOwner, offer.id, "accept");
    const after = await grove.campus.requireWorld(w.id);
    expect(after.ownerHumanId).toBe(orgOwner.id);
    expect(await grove.campus.isMember(w.id, orgOwner.id)).toBe(true);
    expect((await grove.spaceMoves.holderOrg(w.id))?.id).toBe(org.id);
  });

  it("moves to a free plot, frees the old one, and refuses a taken plot, a second move and the commons", async () => {
    const owner = await newHuman("mv-reloc");
    const other = await newHuman("mv-reloc-other");
    const home = await space(owner);
    const w = await space(owner);
    const blocker = await space(other);

    const plan = await grove.spaceMoves.relocationPlan(owner, w.id);
    expect(plan.current).toBe(w.plotIndex);
    expect(plan.anchors).toContain(home.plotIndex);
    expect(plan.options.length).toBeGreaterThan(0);
    expect(plan.options.some((o) => o.plotIndex === blocker.plotIndex)).toBe(false);
    // Suggestions next to the holder's other plot lead the list.
    if (plan.options.some((o) => o.near)) expect(plan.options[0]!.near).toBe(true);

    // The highest options are the least likely to be claimed by a parallel suite.
    const [taken, target] = [...plan.options].map((o) => o.plotIndex).sort((a, b) => b - a);
    await pg.query(`UPDATE worlds SET plot_index = $2 WHERE id = $1`, [blocker.id, taken]);
    expect(await code(grove.spaceMoves.relocate(owner, w.id, { plotIndex: taken, confirm: w.slug }))).toBe("CONFLICT");
    expect(await code(grove.spaceMoves.relocate(owner, w.id, { plotIndex: target, confirm: "wrong" }))).toBe("INVALID");
    expect(await code(grove.spaceMoves.relocate(other, w.id, { plotIndex: target, confirm: w.slug }))).toBe("NOT_FOUND");
    expect((await grove.campus.requireWorld(w.id)).plotIndex).toBe(w.plotIndex);

    const moved = await grove.spaceMoves.relocate(owner, w.id, { plotIndex: target, confirm: w.slug });
    expect(moved.plotIndex).toBe(target);
    const { rowCount } = await pg.query(`SELECT 1 FROM worlds WHERE plot_index = $1`, [w.plotIndex]);
    expect(rowCount).toBe(0);
    const ev = await pg.query(
      `SELECT payload FROM world_events WHERE type = 'space.relocated' AND payload->>'worldId' = $1`,
      [w.id],
    );
    expect(ev.rows[0]?.payload).toMatchObject({ fromPlot: w.plotIndex, toPlot: target });

    const again = await grove.spaceMoves.relocationPlan(owner, w.id);
    expect(again.nextAllowedAt).not.toBeNull();
    const second = again.options[0]!.plotIndex;
    expect(await code(grove.spaceMoves.relocate(owner, w.id, { plotIndex: second, confirm: w.slug }))).toBe("RATE_LIMITED");
    await pg.query(`UPDATE worlds SET relocated_at = now() - interval '8 days' WHERE id = $1`, [w.id]);
    expect((await grove.spaceMoves.relocationPlan(owner, w.id)).nextAllowedAt).toBeNull();

    expect(await code(grove.spaceMoves.relocate(owner, WORLD_ID, { plotIndex: 5, confirm: WORLD_ID }))).toBe("INVALID");
    expect(await code(grove.spaceMoves.offerTransfer(owner, WORLD_ID, { toHumanId: other.id, confirm: WORLD_ID }))).toBe("INVALID");
  });

  it("shows a private space's moves to its members only", async () => {
    const owner = await newHuman("mv-priv");
    const member = await newHuman("mv-priv-member");
    const outsider = await newHuman("mv-priv-out");
    const w = await space(owner, "private");
    await grove.campus.addMember(w.id, member.id);
    const plan = await grove.spaceMoves.relocationPlan(owner, w.id);
    const target = Math.max(...plan.options.map((o) => o.plotIndex));
    await grove.spaceMoves.relocate(owner, w.id, { plotIndex: target, confirm: w.slug });
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'space.relocated' AND payload->>'worldId' = $1`,
      [w.id],
    );
    const id = String(rows[0]!.id);
    expect(await grove.chronicle.entryById(viewer(member.id), id)).not.toBeNull();
    expect(await grove.chronicle.entryById(viewer(owner.id), id)).not.toBeNull();
    expect(await grove.chronicle.entryById(viewer(outsider.id), id)).toBeNull();
    expect(await grove.chronicle.entryById(viewer(null), id)).toBeNull();
    expect(await grove.chronicle.entryById({ humanId: outsider.id, isOperator: true }, id)).toBeNull();
  });
});
