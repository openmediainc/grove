"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPostKind } from "@grove/protocol";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import {
  REPORT_CHOICES,
  authorHref,
  captionLeft,
  cardAccent,
  draftBody,
  draftProblem,
  fileToBase64,
  imageFileProblem,
  postedAgo,
  safeHref,
  type WireBoard,
  type WireBoardPost,
} from "@/lib/board";

/**
 * The artifact board on a space's About tab (queue #36): images, link cards
 * and notes posted by the space's owner and its agents.
 *
 * The board is exactly as visible as the space; a 404 renders nothing, like the
 * card. Images load only through the API (which re-checks access on every
 * request). A link is a card drawn from what the server read (title,
 * description, colours) and opens in a new tab: no iframe, no remote image.
 */
export function BoardSection({ worldId, signedIn }: { worldId: string; signedIn: boolean | null }) {
  const [board, setBoard] = useState<WireBoard | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState<WireBoardPost | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api<WireBoard>(`/api/v1/spaces/${encodeURIComponent(worldId)}/board`));
    } catch {
      setHidden(true);
    }
  }, [worldId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden || !board) return null;
  const posts = board.posts;

  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl text-lantern-300">Board</h2>
      <p className="mt-1 text-sm text-white/45">What this space and its agents have made, posted for anyone who can see the space.</p>
      {board.can_post ? <Composer worldId={worldId} onPosted={(p) => setBoard({ ...board, posts: [p, ...posts] })} /> : null}
      {posts.length === 0 ? (
        <p className="mt-3 text-white/40">
          {board.can_post ? "Nothing on the board yet. Post a screenshot, a link or a note." : "Nothing on the board yet."}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {posts.map((p) => (
            <li key={p.id}>
              <PostCard
                post={p}
                signedIn={signedIn}
                onOpen={() => setOpen(p)}
                onRemoved={() => setBoard({ ...board, posts: posts.filter((x) => x.id !== p.id) })}
              />
            </li>
          ))}
        </ul>
      )}
      {open ? <Lightbox post={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function AuthorLine({ post }: { post: WireBoardPost }) {
  const href = authorHref(post.author);
  const name = <span className="truncate font-semibold text-white/80">{post.author.name}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-white/45">
      {href ? (
        <Link href={href} className="min-w-0 truncate hover:text-lantern-300">
          {name}
        </Link>
      ) : (
        name
      )}
      {post.author.kind === "agent" ? (
        <span className="shrink-0 rounded-full border border-sky-400/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-sky-200">agent</span>
      ) : null}
      <span className="shrink-0">· {postedAgo(post.created_at)}</span>
    </span>
  );
}

function PostCard({
  post,
  signedIn,
  onOpen,
  onRemoved,
}: {
  post: WireBoardPost;
  signedIn: boolean | null;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const [reporting, setReporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accent = post.link ? cardAccent(post.link.preview) : null;

  async function remove() {
    if (busy || !window.confirm("Delete this post from the board? This cannot be undone.")) return;
    setBusy(true);
    try {
      await api(`/api/v1/board/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
      onRemoved();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const href = post.link ? safeHref(post.link.url) : null;
  const preview = post.link?.preview ?? null;

  return (
    <article
      className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-dusk-800/60"
      style={accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : undefined}
    >
      {post.hidden_by_mod ? (
        <p className="border-b border-red-400/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-200">
          Hidden by moderators. Only you can see it.
        </p>
      ) : null}
      {post.image ? (
        <button type="button" onClick={onOpen} className="block w-full bg-dusk-950/60" aria-label={`Open image${post.caption ? `: ${post.caption}` : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with an access check; next/image would proxy it */}
          <img
            src={gp(post.image.url)}
            alt={post.caption ?? `Image posted by ${post.author.name}`}
            width={post.image.width}
            height={post.image.height}
            loading="lazy"
            className="aspect-[4/3] w-full object-cover"
          />
        </button>
      ) : null}
      {post.link ? (
        <div className="px-4 pt-3">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="group block min-w-0">
              <span className="block truncate text-xs text-white/40">{preview?.host || new URL(href).hostname}</span>
              <span className="mt-0.5 block break-words font-semibold text-lantern-300 group-hover:underline">
                {preview?.title ?? href}
              </span>
              {preview?.description ? <span className="mt-1 block break-words text-sm text-white/60">{preview.description}</span> : null}
            </a>
          ) : (
            <span className="block break-all text-sm text-white/60">{post.link.url}</span>
          )}
        </div>
      ) : null}
      {post.caption ? (
        <p className={`whitespace-pre-line break-words px-4 pt-3 ${post.kind === "text" ? "text-base text-white/85" : "text-sm text-white/70"}`}>
          {post.caption}
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-3">
        <AuthorLine post={post} />
        <span className="flex shrink-0 gap-3 text-xs">
          {post.deletable ? (
            <button type="button" onClick={() => void remove()} disabled={busy} className="min-h-11 text-white/45 hover:text-red-300 sm:min-h-0">
              Delete
            </button>
          ) : signedIn ? (
            <button
              type="button"
              onClick={() => setReporting((v) => !v)}
              className="min-h-11 text-white/45 hover:text-lantern-300 sm:min-h-0"
              aria-expanded={reporting}
            >
              Report
            </button>
          ) : null}
        </span>
      </div>
      {reporting ? (
        <ReportForm
          postId={post.id}
          onDone={(msg) => {
            setReporting(false);
            setNote(msg);
          }}
        />
      ) : null}
      {note ? <p className="px-4 pb-3 text-xs text-white/55">{note}</p> : null}
    </article>
  );
}

function ReportForm({ postId, onDone }: { postId: string; onDone: (message: string) => void }) {
  const [category, setCategory] = useState<string>("spam");
  const [details, setDetails] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/v1/board/posts/${encodeURIComponent(postId)}/report`, {
        method: "POST",
        body: JSON.stringify({ category, details: details.trim() || undefined }),
      });
      onDone("Reported. The operators will take a look.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-white/10 px-4 py-3">
      <label className="block text-xs text-white/50">
        What is wrong with it?
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-white/15 bg-dusk-950 px-2 py-2 text-sm text-white"
        >
          {REPORT_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-xs text-white/50">
        Anything the operators should know (optional)
        <textarea
          value={details}
          maxLength={1000}
          onChange={(e) => setDetails(e.target.value)}
          rows={2}
          className="mt-1 block w-full rounded-lg border border-white/15 bg-dusk-950 px-2 py-2 text-sm text-white"
        />
      </label>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-full bg-lantern-400 px-4 py-2 text-xs font-semibold text-dusk-950 disabled:opacity-50"
        >
          Send report
        </button>
        {err ? <span className="text-xs text-red-300">{err}</span> : null}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<BoardPostKind, string> = { image: "Image", link: "Link", text: "Note" };

function Composer({ worldId, onPosted }: { worldId: string; onPosted: (post: WireBoardPost) => void }) {
  const [kind, setKind] = useState<BoardPostKind>("image");
  const [caption, setCaption] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const draft = { kind, caption, url, hasImage: Boolean(file) };
  const problem = draftProblem(draft);
  const left = captionLeft(caption);

  function pick(f: File | null) {
    setErr(null);
    if (!f) return setFile(null);
    const why = imageFileProblem(f);
    if (why) {
      setFile(null);
      setErr(why);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setFile(f);
  }

  async function post() {
    if (problem || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const b64 = kind === "image" && file ? await fileToBase64(file) : null;
      const r = await api<{ post: WireBoardPost }>(`/api/v1/spaces/${encodeURIComponent(worldId)}/board`, {
        method: "POST",
        body: JSON.stringify(draftBody(draft, b64)),
      });
      onPosted(r.post);
      setCaption("");
      setUrl("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-dusk-800/60 px-4 py-3">
      <div role="radiogroup" aria-label="What to post" className="flex flex-wrap gap-2">
        {(["image", "link", "text"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => {
              setKind(k);
              setErr(null);
            }}
            className={`min-h-11 rounded-full border px-3 py-1.5 text-xs sm:min-h-0 ${
              kind === k ? "border-lantern-400/60 bg-lantern-400/15 text-lantern-300" : "border-white/15 text-white/60"
            }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === "image" ? (
        <label className="mt-3 block text-xs text-white/50">
          PNG, JPEG, WebP or GIF, up to 2 MB. Location and camera details are removed.
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-white/70 file:mr-3 file:rounded-full file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-white"
          />
        </label>
      ) : null}
      {kind === "link" ? (
        <label className="mt-3 block text-xs text-white/50">
          Link. It shows as a card with the page&apos;s title and colours, never embedded.
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className="mt-1 block w-full rounded-lg border border-white/15 bg-dusk-950 px-3 py-2 text-sm text-white"
          />
        </label>
      ) : null}
      <label className="mt-3 block text-xs text-white/50">
        {kind === "text" ? "Note" : "Caption (optional)"}
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={kind === "text" ? 3 : 2}
          className="mt-1 block w-full rounded-lg border border-white/15 bg-dusk-950 px-3 py-2 text-sm text-white"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs ${left < 0 ? "text-red-300" : "text-white/35"}`}>{left} characters left</span>
        <button
          type="button"
          onClick={() => void post()}
          disabled={Boolean(problem) || busy}
          title={problem ?? undefined}
          className="min-h-11 rounded-full bg-lantern-400 px-4 py-2 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:min-h-0"
        >
          {busy ? "Posting…" : "Post to board"}
        </button>
      </div>
      {err ? <p className="mt-2 text-sm text-red-300">{err}</p> : null}
    </div>
  );
}

function Lightbox({ post, onClose }: { post: WireBoardPost; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!post.image) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={post.caption ?? "Image"}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 px-4 py-6"
      onClick={onClose}
    >
      <button
        ref={close}
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 min-h-11 rounded-full border border-white/20 px-4 text-sm text-white/80"
      >
        Close
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- see PostCard */}
      <img
        src={gp(post.image.url)}
        alt={post.caption ?? `Image posted by ${post.author.name}`}
        className="max-h-[80vh] max-w-full rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="mt-3 max-w-2xl text-center" onClick={(e) => e.stopPropagation()}>
        {post.caption ? <p className="whitespace-pre-line break-words text-white/85">{post.caption}</p> : null}
        <p className="mt-1 text-xs text-white/45">
          {post.author.name}
          {post.author.kind === "agent" ? " (agent)" : ""} · {postedAgo(post.created_at)}
        </p>
      </div>
    </div>
  );
}
