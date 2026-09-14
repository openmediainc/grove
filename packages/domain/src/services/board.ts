import { createHash } from "node:crypto";
import {
  BOARD_IMAGE_MAX_BYTES,
  BOARD_PAGE_LIMIT,
  WORLD_ID,
  base64DecodedLength,
  formatBoardBytes,
  isBoardPostKind,
  readBoardCaption,
  readBoardLink,
  stripDataUrlPrefix,
  type Agent,
  type BoardLinkPreview,
  type BoardPostKind,
  type BoardPostView,
  type Human,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { withTx } from "../db.js";
import { spaceVisibleSql } from "../visibility.js";
import { inspectBoardImage } from "../board-image.js";
import { SiteFetchError, SiteFetchSession, type SiteFetchOptions } from "../site-fetch.js";
import { readLinkPreview } from "../site-branding.js";
import type { CampusService, WorldRow } from "./campus.js";
import type { QuotaService } from "./quota.js";
import { REPORT_CATEGORIES } from "./moderation.js";

/** Who is reading or posting. A guest or a signed-out visitor is `null`. */
export type BoardActor = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

export type BoardPostInput = {
  kind?: unknown;
  caption?: unknown;
  url?: unknown;
  imageBase64?: unknown;
};

/**
 * How a browser may keep an image (queue #53). `revalidate`: a post on a
 * non-private board, visible to anyone who can see the space; the browser may
 * reuse it briefly and must then ask again with its ETag. `no-store`: a
 * private space's image, a hidden post read by its holder or author, or an
 * operator's read; nothing is kept. Never a shared cache in either case.
 */
export type BoardImageCache = "revalidate" | "no-store";

export type BoardImage = { mime: string; bytes: Buffer; etag: string; cache: BoardImageCache };

/** Seconds a browser may reuse a public board image before it must revalidate. */
export const BOARD_IMAGE_MAX_AGE = 60;

/** The Cache-Control header for each cache class. `private` always: an access check sits in front of every read. */
export function boardImageCacheControl(cache: BoardImageCache): string {
  return cache === "revalidate" ? `private, max-age=${BOARD_IMAGE_MAX_AGE}, must-revalidate` : "private, no-store";
}

/**
 * The version in an image's URL. It changes whenever moderation changes the
 * post (a hide gets a new URL; a hide after an unhide a newer one), so a page
 * that re-reads the board never points at a copy a browser kept from before.
 * A delete removes the post, so its URL is gone from every board and answers 404.
 */
export function boardImageVersion(sha256: string, hiddenByMod: boolean, hiddenAt: unknown): string {
  const at = hiddenAt ? new Date(String(hiddenAt)).getTime() : 0;
  return createHash("sha256").update(`${sha256}|${hiddenByMod ? 1 : 0}|${at}`).digest("hex").slice(0, 12);
}

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

/** The id a visibility check reads for an actor: a human as themself, an agent as its owner. */
function viewerIdOf(actor: BoardActor | null): string | null {
  if (!actor) return null;
  return actor.kind === "human" ? actor.human.id : actor.agent.ownerHumanId;
}

function iso(v: unknown): string {
  return new Date(String(v)).toISOString();
}

/**
 * The SQL condition for "this reader may see this post", given `p` (board_posts)
 * and `w` (its worlds row) and `$viewer`. ONE expression, shared by the board
 * read, the image read and the report path, so the three cannot disagree:
 *  - the space's own door (spaceVisibleSql, queue #50's shared predicate);
 *  - a post hidden by moderators, or by an author who is now suspended, only to
 *    the space's holder and the post's author (so they can see what happened);
 *    everyone else never learns it existed.
 */
function postVisibleSql(viewer: string): string {
  return `(${spaceVisibleSql("w", viewer)}
    AND w.archived_at IS NULL
    AND (
      (NOT p.hidden_by_mod
        AND NOT COALESCE(pa.claim_state = 'suspended', FALSE)
        AND NOT COALESCE(ph.suspended_at IS NOT NULL, FALSE))
      OR (${viewer}::text IS NOT NULL AND (
            w.owner_human_id = ${viewer}::text
            OR p.author_id = ${viewer}::text
            OR pa.owner_human_id = ${viewer}::text))
    ))`;
}

const POST_FROM = `
  FROM board_posts p
  JOIN worlds w ON w.id = p.world_id
  LEFT JOIN agents pa ON p.author_kind = 'agent' AND pa.id = p.author_id
  LEFT JOIN humans ph ON p.author_kind = 'human' AND ph.id = p.author_id`;

const POST_COLUMNS = `
  p.id, p.world_id, p.author_id, p.author_kind, p.kind, p.caption, p.link_url, p.link_preview,
  p.image_mime, p.image_width, p.image_height, p.image_size, p.image_sha256, p.created_at, p.hidden_by_mod, p.hidden_at,
  w.slug::text AS world_slug, w.owner_human_id AS world_owner,
  COALESCE(ph.display_name, pa.display_name, 'Someone') AS author_name,
  COALESCE(ph.handle::text, pa.slug::text) AS author_handle`;

function readPreview(raw: unknown): BoardLinkPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    host: str(r.host) ?? "",
    title: str(r.title),
    description: str(r.description),
    themeColour: str(r.themeColour),
    faviconColour: str(r.faviconColour),
  };
}

/**
 * The artifact board on a space's page (queue #36, migration 041).
 *
 * WHO POSTS. The space's holder (the human who owns it) and agents working for
 * that space: agents the holder owns, or an agent holding a role in the space.
 * An operator does not post (moderation is hiding, not authoring). The commons
 * has no board.
 *
 * WHO READS. Exactly who may see the space page: a private space's board is 404
 * to anyone not inside it, identical to "no such space". Images are served only
 * through the API, which re-applies the same predicate on every request; there
 * is no public URL for any image.
 *
 * WHAT A POST CARRIES. An image sniffed by magic bytes and stripped of metadata
 * (board-image.ts), a link card built by the SSRF-safe fetcher (text and
 * colours only, never a remote image or an iframe), or text. Every post is a
 * `board.posted` row in the chronicle naming the space's plaza, so the
 * chronicle's place gate keeps a private board's activity to its members.
 */
export class BoardService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
    private quota: QuotaService,
    /** Network rules for link previews; tests loosen them for a loopback server. */
    public siteFetchOptions: SiteFetchOptions = {},
  ) {}

  private async visibleSpace(actor: BoardActor | null, ref: string): Promise<WorldRow> {
    const world = await this.campus.getWorld(ref);
    if (!world || world.archivedAt || world.id === WORLD_ID) throw NOT_FOUND();
    const { rows } = await this.store.pg.query<{ ok: boolean }>(
      `SELECT ${spaceVisibleSql("w", "$2")} AS ok FROM worlds w WHERE w.id = $1`,
      [world.id, viewerIdOf(actor)],
    );
    if (!rows[0]?.ok) throw NOT_FOUND();
    return world;
  }

  /** May this actor post to this space's board? */
  async mayPost(actor: BoardActor | null, world: WorldRow): Promise<boolean> {
    if (!actor || !world.ownerHumanId || world.id === WORLD_ID) return false;
    if (actor.kind === "human") return world.ownerHumanId === actor.human.id;
    const agent = actor.agent;
    if (agent.claimState !== "claimed") return false;
    if (agent.ownerHumanId && agent.ownerHumanId === world.ownerHumanId) return true;
    const { rowCount } = await this.store.pg.query(`SELECT 1 FROM roles WHERE world_id = $1 AND holder_agent_id = $2`, [
      world.id,
      agent.id,
    ]);
    return (rowCount ?? 0) > 0;
  }

  private toView(r: Record<string, unknown>, actor: BoardActor | null): BoardPostView {
    const humanId = actor?.kind === "human" ? actor.human.id : null;
    const id = String(r.id);
    const kind = String(r.kind) as BoardPostKind;
    return {
      id,
      space: String(r.world_id),
      kind,
      caption: r.caption == null ? null : String(r.caption),
      author: {
        id: String(r.author_id),
        kind: r.author_kind === "agent" ? "agent" : "human",
        name: String(r.author_name),
        handle: r.author_handle == null ? null : String(r.author_handle),
      },
      createdAt: iso(r.created_at),
      link: kind === "link" && r.link_url ? { url: String(r.link_url), preview: readPreview(r.link_preview) } : null,
      image:
        kind === "image" && r.image_mime
          ? {
              url: `/api/v1/board/posts/${encodeURIComponent(id)}/image?v=${boardImageVersion(String(r.image_sha256 ?? ""), Boolean(r.hidden_by_mod), r.hidden_at)}`,
              mime: String(r.image_mime),
              width: Number(r.image_width),
              height: Number(r.image_height),
              size: Number(r.image_size),
            }
          : null,
      hiddenByMod: Boolean(r.hidden_by_mod),
      deletable: Boolean(humanId && r.world_owner === humanId),
    };
  }

  /** A space's board, newest first. `before` pages back by created_at. */
  async list(
    actor: BoardActor | null,
    ref: string,
    opts: { before?: string | null; limit?: number } = {},
  ): Promise<{ space: { id: string; slug: string }; posts: BoardPostView[]; canPost: boolean }> {
    const world = await this.visibleSpace(actor, ref);
    const viewerId = viewerIdOf(actor);
    const limit = Math.min(Math.max(Number(opts.limit) || BOARD_PAGE_LIMIT, 1), BOARD_PAGE_LIMIT);
    const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? opts.before : null;
    const { rows } = await this.store.pg.query(
      `SELECT ${POST_COLUMNS} ${POST_FROM}
        WHERE p.world_id = $1
          AND ${postVisibleSql("$2")}
          AND ($3::timestamptz IS NULL OR p.created_at < $3::timestamptz)
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $4`,
      [world.id, viewerId, before, limit],
    );
    return {
      space: { id: world.id, slug: world.slug },
      posts: rows.map((r) => this.toView(r, actor)),
      canPost: await this.mayPost(actor, world),
    };
  }

  /** One post as this reader sees it, or 404. */
  async get(actor: BoardActor | null, postId: string): Promise<BoardPostView> {
    const viewerId = viewerIdOf(actor);
    const { rows } = await this.store.pg.query(
      `SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.id = $1 AND ${postVisibleSql("$2")}`,
      [postId, viewerId],
    );
    if (!rows[0]) throw NOT_FOUND();
    return this.toView(rows[0], actor);
  }

  async post(actor: BoardActor, ref: string, input: BoardPostInput): Promise<BoardPostView> {
    const world = await this.visibleSpace(actor, ref);
    if (!(await this.mayPost(actor, world))) {
      throw new GroveError("PERMISSION_DENIED", "Only this space's owner and its agents post to its board.", {
        httpStatus: 403,
      });
    }
    if (!isBoardPostKind(input.kind)) throw new GroveError("INVALID", "kind must be image, link or text.");
    const kind = input.kind;
    const caption = readBoardCaption(input.caption);
    if (!caption.ok) throw new GroveError("INVALID", caption.message);
    if (kind === "text" && !caption.value) throw new GroveError("INVALID", "A text post needs a caption.");

    let linkUrl: string | null = null;
    let image: { mime: string; width: number; height: number; bytes: Buffer } | null = null;
    if (kind === "link") {
      const link = readBoardLink(input.url);
      if (!link.ok) throw new GroveError("INVALID", link.message);
      // Refuse an address that is not a public website before anything is
      // stored or fetched (same rules as the fetch itself, no network).
      try {
        new SiteFetchSession(this.siteFetchOptions).checkUrl(link.value);
      } catch (e) {
        if (e instanceof SiteFetchError) throw new GroveError("INVALID", e.message, { details: { reason: e.reason } });
        throw e;
      }
      linkUrl = link.value;
    } else if (kind === "image") {
      if (typeof input.imageBase64 !== "string" || !input.imageBase64) {
        throw new GroveError("INVALID", "An image post needs image_base64 (PNG, JPEG, WebP or GIF, at most 2 MB).");
      }
      const b64 = stripDataUrlPrefix(input.imageBase64.trim());
      const declared = base64DecodedLength(b64);
      if (declared > BOARD_IMAGE_MAX_BYTES) {
        throw new GroveError(
          "INVALID",
          `Images are at most ${formatBoardBytes(BOARD_IMAGE_MAX_BYTES)}; that one is ${formatBoardBytes(declared)}.`,
          { details: { reason: "too_large" } },
        );
      }
      if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(b64)) {
        throw new GroveError("INVALID", "image_base64 is not base64.", { details: { reason: "format" } });
      }
      const verdict = inspectBoardImage(Buffer.from(b64, "base64"));
      if (!verdict.ok) throw new GroveError("INVALID", verdict.message, { details: { reason: verdict.reason } });
      image = verdict;
    }

    const actorId = actor.kind === "human" ? actor.human.id : actor.agent.id;
    // Charged only once the post is valid, and before the network read.
    await this.quota.consumeBoardPost(actorId, world.id);

    let preview: BoardLinkPreview | null = null;
    if (linkUrl) {
      try {
        const p = await readLinkPreview(linkUrl, this.siteFetchOptions);
        preview = { host: p.host, title: p.title, description: p.description, themeColour: p.themeColour, faviconColour: p.faviconColour };
      } catch (e) {
        // A redirect into private space is refused outright; a site that is
        // merely slow, down or not HTML still gets a plain card.
        if (e instanceof SiteFetchError && (e.reason === "blocked" || e.reason === "bad_url")) {
          throw new GroveError("INVALID", e.message, { details: { reason: e.reason } });
        }
        if (!(e instanceof SiteFetchError)) throw e;
        preview = null;
      }
    }

    const id = newId("boardPost");
    await withTx(this.store.pg, async (c) => {
      await c.query(
        `INSERT INTO board_posts (id, world_id, author_id, author_kind, kind, caption, link_url, link_preview,
                                  image_mime, image_width, image_height, image_size, image_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          world.id,
          actorId,
          actor.kind,
          kind,
          caption.value,
          linkUrl,
          preview ? JSON.stringify(preview) : null,
          image?.mime ?? null,
          image?.width ?? null,
          image?.height ?? null,
          image?.bytes.length ?? null,
          image ? createHash("sha256").update(image.bytes).digest("hex") : null,
        ],
      );
      if (image) await c.query(`INSERT INTO board_images (post_id, bytes) VALUES ($1, $2)`, [id, image.bytes]);
      // The space's plaza is the place, so the chronicle's shared place gate
      // decides who hears of it. Never the caption, url or bytes.
      await c.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('board.posted', $1, $2)`, [
        actorId,
        JSON.stringify({ roomId: `${world.id}:plaza`, postId: id, postKind: kind, space: world.name }),
      ]);
    });
    return this.get(actor, id);
  }

  /** The bytes of an image post, for a reader who may see the post. */
  async image(actor: BoardActor | null, postId: string): Promise<BoardImage> {
    const { rows } = await this.store.pg.query(
      `SELECT p.image_mime, p.image_sha256, i.bytes,
              (w.policy_preset = 'private' OR p.hidden_by_mod
                OR COALESCE(pa.claim_state = 'suspended', FALSE)
                OR COALESCE(ph.suspended_at IS NOT NULL, FALSE)) AS no_store
         ${POST_FROM}
         JOIN board_images i ON i.post_id = p.id
        WHERE p.id = $1 AND ${postVisibleSql("$2")}`,
      [postId, viewerIdOf(actor)],
    );
    const r = rows[0];
    if (!r) throw NOT_FOUND();
    return {
      mime: String(r.image_mime),
      bytes: r.bytes as Buffer,
      etag: String(r.image_sha256),
      cache: r.no_store ? "no-store" : "revalidate",
    };
  }

  /** The space's holder removes a post from their board. Anyone else: 404. */
  async remove(human: Human, postId: string): Promise<{ id: string; deleted: true }> {
    const { rows } = await this.store.pg.query(
      `DELETE FROM board_posts p USING worlds w
        WHERE p.id = $1 AND w.id = p.world_id AND w.owner_human_id = $2
        RETURNING p.id, p.world_id, p.author_id, p.kind`,
      [postId, human.id],
    );
    const r = rows[0];
    if (!r) throw NOT_FOUND();
    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('board.removed', $1, $2)`, [
      human.id,
      JSON.stringify({ postId, worldId: String(r.world_id), authorId: String(r.author_id), postKind: String(r.kind) }),
    ]);
    return { id: postId, deleted: true };
  }

  /**
   * Report a post into the operators' queue. The report's target is the post's
   * author (so warn / suspend apply as for any report) with `target_kind`
   * 'board_post' naming the post. Only someone who can see the post may report
   * it; anyone else gets the same 404 as a missing post.
   */
  async report(human: Human, postId: string, input: { category?: unknown; details?: unknown }) {
    const post = await this.get({ kind: "human", human }, postId);
    const category = typeof input.category === "string" ? input.category : "other";
    if (!(REPORT_CATEGORIES as readonly string[]).includes(category)) {
      throw new GroveError("INVALID", "Unknown report category.");
    }
    const details = typeof input.details === "string" && input.details.trim() ? input.details.trim().slice(0, 1000) : null;
    await this.quota.consumeReport(human.id, false);
    const id = newId("report");
    const snapshot = {
      boardPost: {
        id: post.id,
        kind: post.kind,
        caption: post.caption,
        linkUrl: post.link?.url ?? null,
        space: post.space,
        authorId: post.author.id,
        createdAt: post.createdAt,
      },
    };
    await this.store.pg.query(
      `INSERT INTO reports (id, reporter_id, target_id, category, details, snapshot, target_kind, target_ref)
       VALUES ($1,$2,$3,$4,$5,$6,'board_post',$7)`,
      [id, human.id, post.author.id, category, details, JSON.stringify(snapshot), post.id],
    );
    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('report', $1, $2)`, [
      human.id,
      JSON.stringify({ reportId: id, targetId: post.author.id, targetKind: "board_post", targetRef: post.id }),
    ]);
    return { id, status: "open" };
  }

  /** Operators hide (or restore) a post. A reason is required to hide. */
  async setHidden(operator: Human, postId: string, hidden: boolean, reason: unknown) {
    if (operator.role !== "operator") throw NOT_FOUND();
    const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 1000) : null;
    if (hidden && !why) throw new GroveError("INVALID", "A reason is required to hide a post.");
    const { rows } = await this.store.pg.query(
      `UPDATE board_posts
          SET hidden_by_mod = $2,
              hidden_at = CASE WHEN $2 THEN now() ELSE NULL END,
              hidden_by = CASE WHEN $2 THEN $3 ELSE NULL END,
              hidden_reason = CASE WHEN $2 THEN $4 ELSE NULL END
        WHERE id = $1
        RETURNING id, author_id, world_id`,
      [postId, hidden, operator.id, why],
    );
    const r = rows[0];
    if (!r) throw NOT_FOUND();
    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ($1, $2, $3)`, [
      hidden ? "mod.board_hide" : "mod.board_unhide",
      operator.id,
      JSON.stringify({ postId, targetId: String(r.author_id), worldId: String(r.world_id), reason: why, by: operator.id }),
    ]);
    return { id: postId, hiddenByMod: hidden };
  }

  /** Operators read a reported image whatever the space's door (the queue needs to see what was reported). */
  async imageForOperator(operator: Human, postId: string): Promise<BoardImage> {
    if (operator.role !== "operator") throw NOT_FOUND();
    const { rows } = await this.store.pg.query(
      `SELECT p.image_mime, p.image_sha256, i.bytes FROM board_posts p JOIN board_images i ON i.post_id = p.id WHERE p.id = $1`,
      [postId],
    );
    const r = rows[0];
    if (!r) throw NOT_FOUND();
    return { mime: String(r.image_mime), bytes: r.bytes as Buffer, etag: String(r.image_sha256), cache: "no-store" };
  }
}
