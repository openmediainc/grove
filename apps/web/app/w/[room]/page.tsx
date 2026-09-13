"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, WS_ORIGIN, type Nearby, type RoomPayload } from "@/lib/api";
import { gp } from "@/lib/base";
import type { RefusalInput } from "@grove/ui";
import { GeoAvatar } from "@/components/Avatar";
import { FirstFiveMinutes, noteSpoke, type TranscriptLine } from "@/components/FirstFiveMinutes";
import { PixelRoom } from "@/components/PixelRoom";
import { Reactions } from "@/components/Reactions";
import {
  mergeLineReactions,
  reactionPollDelay,
  withLiveCounts,
  type ReactionSummaryWire,
} from "@/lib/reactions";
import { RefusalNotice, toRefusalInput } from "@/components/RefusalNotice";
import { RoomSignpost, type SignpostRoom } from "@/components/RoomSignpost";
import {
  CIVIC_CORE_WORLD_ID,
  RoomPresence,
  spaceSilencedActorIds,
  type SpaceSilenceSource,
} from "@/components/RoomPresence";
import { readPixelFlag, writePixelFlag } from "@/lib/pixel";
import { WhisperBar, type WhisperCheckState } from "@/components/WhisperBar";
import {
  emitWhisperEvent,
  leadingMention,
  nameFor,
  parseWhisperCommand,
  refusalFromWire,
  type SayAckWire,
  type WhisperCheckWire,
  type WhisperLine,
} from "@/lib/whisper";

/**
 * Only a fallback now. The campus list is built from `GET /api/v1/civic`, which
 * is the one thing that knows how many civic rooms there are — the hard-coded
 * list used to carry a seventh entry the civic payload has never described, and
 * would have gone on showing six if a seventh room were ever seeded.
 */
const FALLBACK_ROOMS = ["plaza", "library", "workshop", "stage", "garden", "board"];

/**
 * What a room is doing, straight off GET /api/v1/civic.
 *
 * `state` is a closed set the server owns, and this page draws states rather
 * than room names — the Stage is lit because an event is running in it, not
 * because of its slug. That is the same contract WorldMap.tsx should take: no
 * room is a special case, and a seventh room arrives already drawable.
 */
type RoomStatus = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  capacity: number;
  occupancy: number;
  spectator_visible: boolean;
  allows_room_say: boolean;
  say_limit_per_min: number | null;
  state: "empty" | "quiet" | "busy" | "live" | "posted";
  headline: string | null;
  byline: string | null;
  until: string | null;
};

type NoticeCard = {
  id: string;
  title: string;
  body: string;
  author_slug: string | null;
  author_name: string | null;
  pinned: boolean;
  pinned_on: string | null;
  created_at: string;
};

type BoardView = {
  day: string;
  pin: NoticeCard | null;
  posts: NoticeCard[];
  withheld: number;
  pin_opens_at: string | null;
};

/** One dot per state. The only place a state becomes a colour. */
const STATE_DOT: Record<RoomStatus["state"], string> = {
  empty: "bg-white/15",
  quiet: "bg-white/40",
  busy: "bg-lantern-400/70",
  posted: "bg-sky-300",
  live: "bg-rose-400 animate-pulse",
};

/**
 * `GET /api/v1/rooms/:slug` returns the room row, and `mapRoom()` carries
 * `world_id` — but not the space's access level, which lives on the WORLD.
 * `silencedBySpace` is a fact about the room an actor is standing in and cannot
 * be derived from `badges()`, so the space is fetched separately and only when
 * the room is not in the civic core (which narrows nothing).
 *
 * The same payload carries everything the signpost states about a room — kind,
 * capacity, say limit, whether a signed-out visitor can watch it — so the sign
 * is read off the room row rather than written per slug.
 */
type RoomWithWorld = RoomPayload["room"] &
  Partial<SignpostRoom> & { world_id?: string };

export default function RoomPage() {
  const { room } = useParams<{ room: string }>();
  const [data, setData] = useState<RoomPayload | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [draft, setDraft] = useState("");
  const [noticeTitle, setNoticeTitle] = useState("");
  const [board, setBoard] = useState<BoardView | null>(null);
  const [civic, setCivic] = useState<RoomStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalInput | null>(null);
  const [space, setSpace] = useState<SpaceSilenceSource | null>(null);
  const [me, setMe] = useState<{ id: string; handle?: string } | null>(null);
  const [pixel, setPixel] = useState(true);
  /** Walked straight in from /enter, rather than arriving by link or reload. */
  const [arrived, setArrived] = useState(false);
  const [stepping, setStepping] = useState(false);
  const composeRef = useRef<HTMLInputElement>(null);
  /**
   * Who the compose box is whispering to, or null for the room. Kept as the
   * roster row it was picked from, so a body that walks out is still named.
   */
  const [whisperTo, setWhisperTo] = useState<Nearby | null>(null);
  const [whisperCheck, setWhisperCheck] = useState<WhisperCheckState>({ status: "checking" });
  /**
   * Private lines, the reader's own. Separate from `lines` on purpose: the
   * transcript endpoint is room_say only and `load()` replaces `lines`
   * wholesale, which would silently erase every whisper on the next refresh.
   */
  const [whispers, setWhispers] = useState<WhisperLine[]>([]);
  const [sending, setSending] = useState(false);
  /** The room socket is open, so reaction counts arrive as pushes rather than by poll. */
  const [socketLive, setSocketLive] = useState(false);

  useEffect(() => {
    setPixel(readPixelFlag());
    // Read off the URL rather than through useSearchParams: this page is a
    // client component either way, and the hook would force a Suspense boundary
    // around the whole room for one boolean.
    try {
      setArrived(new URLSearchParams(window.location.search).get("arrived") === "1");
    } catch {
      setArrived(false);
    }
  }, []);

  async function load() {
    const r = await api<RoomPayload>(`/api/v1/rooms/${room}`);
    setData(r);
    setSpace(await loadSpace(r.room as RoomWithWorld));
    const t = await api<{ transcript: TranscriptLine[] }>(`/api/v1/rooms/${r.room.slug}/transcript`);
    setLines(t.transcript);
    // One call for all six rooms: the point of the room states is that you can
    // see what the OTHER rooms are doing without walking into them.
    const c = await api<{ rooms: RoomStatus[] }>("/api/v1/civic").catch(() => ({ rooms: [] }));
    setCivic(c.rooms ?? []);
    if (r.room.slug === "board" || room === "board") {
      // /api/v1/civic/board, not /api/v1/notices: the pin is a distinct object
      // from the rest of the board, and this route is the one that runs every
      // line past the permission kernel for THIS reader.
      const b = await api<{ board: BoardView }>("/api/v1/civic/board");
      setBoard(b.board);
    }
  }

  useEffect(() => {
    void api<{ human: { id: string; handle: string } }>("/api/v1/humans/me")
      .then((h) => setMe(h.human))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    void load().catch((e) => {
      if ((e as { status?: number }).status === 401) window.location.href = gp("/login");
      setErr((e as Error).message);
    });
  }, [room]);

  useEffect(() => {
    if (!me) return;
    let ws: WebSocket | null = null;
    void (async () => {
      try {
        const t = await api<{ ticket: string }>("/api/v1/humans/ws-ticket", { method: "POST", body: "{}" });
        const origin = WS_ORIGIN.replace(/^http/, "ws");
        ws = new WebSocket(`${origin}/api/v1/ws/human?ticket=${t.ticket}`);
        ws.onopen = () => setSocketLive(true);
        ws.onclose = () => setSocketLive(false);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type?: string; body?: string; sender_id?: string; sender_kind?: string; speech_id?: string; room_id?: string };
            // Counts only, and the server sends them only to readers the line
            // reached (roomFrameFor), so there is nothing to filter here.
            if (msg.type === "reaction_counts") {
              const f = msg as { target_kind?: string; target_id?: string; counts?: unknown };
              if (f.target_kind !== "speech" || !f.target_id) return;
              const id = f.target_id;
              setLines((cur) => {
                const line = cur.find((l) => l.id === id);
                return line ? mergeLineReactions(cur, new Map([[id, withLiveCounts(line.reactions, f.counts)]])) : cur;
              });
              return;
            }
            if (msg.type === "speech" && msg.body) {
              const channel = (msg as { channel?: string }).channel ?? "room_say";
              if (channel === "whisper") {
                const targetId = (msg as { target_id?: string }).target_id;
                // Our own whisper echoes back on the room channel; the ack has
                // already put it in the log. Anything not addressed to us is
                // not ours to show (the server drops those; this is the belt).
                if (msg.sender_id === me.id || targetId !== me.id) return;
                const line: WhisperLine = {
                  id: msg.speech_id ?? String(Date.now()),
                  body: msg.body,
                  direction: "in",
                  other_id: msg.sender_id ?? "",
                  other_kind: msg.sender_kind === "agent" ? "agent" : "human",
                  created_at: new Date().toISOString(),
                };
                setWhispers((cur) => (cur.some((w) => w.id === line.id) ? cur : [...cur, line]));
                return;
              }
              // Owner-channel frames are private too, and have their own thread;
              // printing them here would put them in the ROOM's log.
              if (channel !== "room_say") return;
              setLines((cur) => cur.some((l) => l.id === msg.speech_id) ? cur : [
                ...cur,
                {
                  id: msg.speech_id ?? String(Date.now()),
                  body: msg.body!,
                  sender_id: msg.sender_id ?? "",
                  sender_kind: msg.sender_kind ?? "human",
                  // The push carries no timestamp; it arrived as it was said, so
                  // "just now" is the truth rather than a guess.
                  created_at: new Date().toISOString(),
                },
              ]);
            }
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* ticket optional */
      }
    })();
    return () => {
      ws?.close();
      setSocketLive(false);
    };
  }, [me, room]);

  /**
   * The light poll behind live reaction counts: counts only, for the lines the
   * transcript shows this reader, and only while the tab is visible. It is the
   * live path where the socket does not hold (Vercel is serverless) and a slow
   * catch-up where it does. Coming back to the tab refreshes at once.
   */
  useEffect(() => {
    if (!me || !data) return;
    const slug = data.room.slug;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const delay = reactionPollDelay(socketLive, visible());
      if (delay !== null && !stopped) timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      try {
        const r = await api<{ reactions: Array<{ speech_id: string; summary?: ReactionSummaryWire }> }>(
          `/api/v1/rooms/${slug}/reactions`,
        );
        const updates = new Map<string, ReactionSummaryWire>();
        for (const x of r.reactions ?? []) if (x.summary) updates.set(x.speech_id, x.summary);
        if (!stopped) setLines((cur) => mergeLineReactions(cur, updates));
      } catch {
        /* a missed poll is only a stale count */
      }
      schedule();
    };
    const onVisibility = () => {
      if (visible()) void tick();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [me, data?.room.slug, socketLive]);

  async function enter(slug: string) {
    await api(`/api/v1/rooms/${slug}/enter`, { method: "POST", body: "{}" });
    if (slug !== room) window.location.href = gp(`/w/${slug}`);
    else await load();
  }

  async function say() {
    if (whisperTo) return whisper(whisperTo);
    setErr(null);
    setRefusal(null);
    try {
      await api("/api/v1/say", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ channel: "room_say", body: draft }),
      });
      noteSpoke();
      setDraft("");
      await load();
    } catch (e) {
      // Not `err.message`: a refusal has to name the right door, and the error
      // body carries what is needed to work out which one.
      setRefusal(toRefusalInput(e, "human"));
    }
  }

  /**
   * A whisper stays in whisper mode after it is sent: you are talking to
   * someone. The way back is the "Back to the room" button or Esc.
   */
  async function whisper(target: Nearby) {
    const body = draft;
    if (!body.trim() || sending) return;
    if (whisperCheck.status === "refused" || whisperCheck.status === "checking") return;
    setErr(null);
    setRefusal(null);
    setSending(true);
    try {
      const r = await api<{ speech: SayAckWire }>("/api/v1/say", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ channel: "whisper", target_id: target.actor_id, body }),
      });
      const missed = r.speech.undelivered.find((u) => u.actor_id === target.actor_id) ?? r.speech.undelivered[0];
      const line: WhisperLine = {
        id: r.speech.id,
        body,
        direction: "out",
        other_id: target.actor_id,
        other_kind: target.kind,
        created_at: new Date().toISOString(),
        undelivered: missed ? refusalFromWire(missed, target.kind) : null,
      };
      setWhispers((cur) => (cur.some((w) => w.id === line.id) ? cur : [...cur, line]));
      setDraft("");
      emitWhisperEvent({ phase: "sent", speakerId: me?.id ?? null, targetId: target.actor_id, roomSlug: data?.room.slug ?? room });
      // It went nowhere: the check was stale (a setting changed, a block landed).
      // Show the up-to-date refusal in the bar, not only on the line.
      if (missed) setWhisperCheck({ status: "refused", refusal: refusalFromWire(missed, target.kind) });
    } catch (e) {
      setRefusal(toRefusalInput(e, "human", { channel: "whisper", recipientKind: target.kind }));
    } finally {
      setSending(false);
    }
  }

  function startWhisper(target: Nearby, rest?: string) {
    if (target.actor_id === me?.id) return;
    setRefusal(null);
    setWhisperTo(target);
    if (rest !== undefined) setDraft(rest);
    emitWhisperEvent({ phase: "target", speakerId: me?.id ?? null, targetId: target.actor_id, roomSlug: data?.room.slug ?? room });
    composeRef.current?.focus();
  }

  function stopWhisper() {
    if (!whisperTo) return;
    setWhisperTo(null);
    setRefusal(null);
    emitWhisperEvent({ phase: "cleared", speakerId: me?.id ?? null, targetId: null, roomSlug: data?.room.slug ?? room });
    composeRef.current?.focus();
  }

  /** Ask the kernel, not the badges: privacy, blocks and the space all count. */
  useEffect(() => {
    if (!whisperTo) return;
    let live = true;
    setWhisperCheck({ status: "checking" });
    void api<{ check: WhisperCheckWire }>(`/api/v1/whisper/check?target_id=${encodeURIComponent(whisperTo.actor_id)}`)
      .then((r) => {
        if (!live) return;
        setWhisperCheck(
          r.check.allowed || !r.check.refusal
            ? { status: "allowed" }
            : { status: "refused", refusal: refusalFromWire(r.check.refusal, whisperTo.kind) },
        );
      })
      .catch(() => {
        if (live) setWhisperCheck({ status: "unknown" });
      });
    return () => {
      live = false;
    };
  }, [whisperTo?.actor_id]);

  async function pinNotice() {
    setErr(null);
    try {
      await api("/api/v1/notices", {
        method: "POST",
        body: JSON.stringify({ title: noticeTitle || draft.slice(0, 80), body: draft }),
      });
      setDraft("");
      setNoticeTitle("");
      await load();
    } catch (e) {
      setRefusal(toRefusalInput(e, "human"));
    }
  }

  /** This room's own state, from the same one call the nav uses. */
  const here = useMemo(() => civic.find((c) => c.slug === (data?.room.slug ?? room)) ?? null, [civic, data, room]);

  /**
   * The campus list, plus the one room civic never returns. An owner lounge is
   * created per human and excluded from listPublicRooms on purpose, so it has
   * no state to show and has to be named here or it would disappear entirely.
   */
  const navRooms = useMemo(() => {
    const rooms = civic.length
      ? civic.map((c) => ({ slug: c.slug, name: c.name }))
      : FALLBACK_ROOMS.map((s) => ({ slug: s, name: s }));
    return [...rooms, { slug: "lounge", name: "your lounge" }];
  }, [civic]);

  /**
   * Are you actually IN this room?
   *
   * Opening /w/plaza does not put you in the Plaza — `POST /world/enter` or
   * `POST /rooms/:slug/enter` does — and presence is swept, so a body that
   * walked in this morning is not in the room by the afternoon. Until now the
   * page looked identical either way: the room drew, the compose box drew, and
   * the only sign was that `POST /say` came back NOT_FOUND, which the refusal
   * renders as "That room or person is not here any more" — a sentence about
   * the room, when the thing that is missing is YOU.
   *
   * The roster is the authority and it lists lurkers too, so absence from it is
   * absence from the room. `null` while it loads: say nothing rather than
   * accuse the reader of not being somewhere.
   */
  const standingHere = useMemo(() => {
    if (!data || !me) return null;
    return data.nearby.some((n) => n.actor_id === me.id);
  }, [data, me]);

  /**
   * Stepping in is left as a button on purpose. Being in a room is a social
   * act in Grove — you become visible, addressable and overhearable — so the
   * page will not do it to you because you happened to open a URL.
   */
  async function stepIn() {
    setErr(null);
    setRefusal(null);
    setStepping(true);
    try {
      await api(`/api/v1/rooms/${data?.room.slug ?? room}/enter`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStepping(false);
    }
  }

  /** Who said it. The transcript used to print only HUMAN / AGENT and the body. */
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    if (whisperTo) m.set(whisperTo.actor_id, nameFor(whisperTo));
    for (const n of data?.nearby ?? []) m.set(n.actor_id, n.display_name || n.slug);
    return m;
  }, [data, whisperTo]);

  /** The room's lines and the reader's private ones, in the order they happened. */
  const log = useMemo(() => {
    type Entry = { at: number; order: number } & (
      | { kind: "say"; line: TranscriptLine }
      | { kind: "whisper"; line: WhisperLine }
    );
    const at = (s?: string) => {
      const t = s ? Date.parse(s) : NaN;
      return Number.isNaN(t) ? 0 : t;
    };
    const out: Entry[] = [
      ...lines.map((line, i) => ({ kind: "say" as const, line, at: at(line.created_at), order: i })),
      ...whispers.map((line, i) => ({ kind: "whisper" as const, line, at: at(line.created_at), order: lines.length + i })),
    ];
    return out.sort((a, b) => a.at - b.at || a.order - b.order);
  }, [lines, whispers]);

  const mention = useMemo(
    () => (whisperTo ? null : leadingMention(draft, data?.nearby ?? [], me?.id)),
    [draft, data, me, whisperTo],
  );

  /**
   * Bubbles for the pixel room, with their times so the newest line per speaker
   * wins and a line from an hour ago is not still over somebody's head. A
   * whisper arrives only to the people it was delivered to, and is drawn as one.
   */
  const roomBubbles = useMemo(
    () => [
      ...lines.map((l) => ({ sender_id: l.sender_id, body: l.body, created_at: l.created_at, whisper: false })),
      // Only the reader's own whispers are in `whispers`, so drawing them here
      // shows them to nobody who was not party to them.
      ...whispers.map((w) => ({
        sender_id: w.direction === "in" ? w.other_id : me?.id ?? "",
        body: w.body,
        created_at: w.created_at,
        whisper: true,
      })),
    ],
    [lines, whispers, me],
  );

  const seats = useMemo(() => {
    const cap = Math.min(data?.room.capacity ?? 30, 48);
    const nearby = data?.nearby ?? [];
    return Array.from({ length: cap }, (_, i) => nearby.find((n) => n.presence.seat_index === i) ?? null);
  }, [data]);

  // Reconstructed, not invented: the space's access level plus its roster, which
  // is exactly what the kernel intersects with each actor's own matrix.
  const silencedActorIds = useMemo(
    () =>
      spaceSilencedActorIds(
        data?.nearby ?? [],
        (data?.room as RoomWithWorld | undefined)?.world_id,
        space,
        data?.room.id,
      ),
    [data, space],
  );

  /**
   * The sign is drawn from the room row where there is one, and from the civic
   * row otherwise, so it is right on the first paint rather than after the
   * second fetch.
   */
  const signpostRoom: SignpostRoom | null = useMemo(() => {
    const r = data?.room as RoomWithWorld | undefined;
    if (r && r.slug) {
      return {
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        capacity: r.capacity,
        say_limit_per_min: r.say_limit_per_min ?? null,
        spectator_visible: Boolean(r.spectator_visible),
        allows_room_say: r.allows_room_say ?? true,
      };
    }
    return here
      ? {
          slug: here.slug,
          name: here.name,
          kind: here.kind,
          capacity: here.capacity,
          say_limit_per_min: here.say_limit_per_min,
          spectator_visible: here.spectator_visible,
          allows_room_say: here.allows_room_say,
        }
      : null;
  }, [data, here]);

  return (
    <main className="grid min-h-[calc(100vh-56px)] grid-cols-1 lg:grid-cols-[200px_1fr_320px]">
      {/* On a phone the campus list is a strip you swipe, not seven rows the
          room has to be scrolled past. */}
      <aside className="border-b border-white/10 p-4 max-lg:py-2 lg:border-b-0 lg:border-r">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400 max-lg:sr-only">Campus</h2>
        <ul className="mt-3 flex gap-1 overflow-x-auto max-lg:mt-0 lg:block lg:space-y-1">
          {navRooms.map((r) => {
            const st = civic.find((c) => c.slug === r.slug);
            return (
              <li key={r.slug} className="shrink-0">
                <button
                  onClick={() => enter(r.slug)}
                  className={`w-full whitespace-nowrap rounded-lg px-3 py-2 text-left ${r.slug === room ? "bg-lantern-400/20 text-lantern-300" : "hover:bg-white/5"}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[st?.state ?? "empty"]}`} />
                    <span className="flex-1">{r.name}</span>
                    {st?.occupancy ? <span className="text-[10px] text-white/35">{st.occupancy}</span> : null}
                  </span>
                  {st?.headline ? (
                    <span className="mt-0.5 block truncate pl-3.5 text-[11px] text-white/50 max-lg:hidden">{st.headline}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="flex flex-col cobble">
        <div className="flex flex-col gap-3 border-b border-white/10 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="min-w-0">
            <h1 className="font-display text-3xl text-lantern-300">{data?.room.name ?? room}</h1>
            {/* The sign outside the door: what this room is for, what is true of
                it, and what is happening in it now. Permanent, not onboarding. */}
            <RoomSignpost room={signpostRoom} now={here} />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => {
                const next = !pixel;
                setPixel(next);
                writePixelFlag(next);
              }}
              className={`rounded-full px-3 py-1 text-xs uppercase tracking-widest ${pixel ? "bg-lantern-400 text-dusk-950" : "border border-lantern-400/40 text-lantern-300"}`}
            >
              Pixel view
            </button>
            <span className="text-xs text-white/40">{data?.nearby.length ?? 0} here</span>
          </div>
        </div>
        {standingHere === false ? (
          <div className="mx-4 mt-4 flex max-w-3xl flex-col gap-3 rounded-2xl border border-lantern-400/40 bg-dusk-900/80 p-4 sm:mx-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-white/70">
              <strong className="text-lantern-300">You are looking in from outside.</strong> Nobody in{" "}
              {theRoom(data?.room.name ?? room)} can see or hear you, and nothing you type will reach them,
              until you step in.
            </p>
            <button
              onClick={stepIn}
              disabled={stepping}
              className="shrink-0 rounded-full bg-lantern-400 px-5 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-60 sm:py-1.5"
            >
              {stepping ? "Stepping in…" : `Step into ${theRoom(data?.room.name ?? room)} →`}
            </button>
          </div>
        ) : null}
        {/* The Plaza is where everybody lands, so it is the only room that says
            what the campus is for. Retires itself; see the component. */}
        {/* On a phone the room itself comes before the onboarding card: the bodies
            and what they are saying are the reason to be here. */}
        {(data?.room.slug ?? room) === "plaza" ? (
          <div className="max-lg:order-2">
          <FirstFiveMinutes
            me={me}
            nearby={data?.nearby ?? []}
            lines={lines}
            arrived={arrived}
            standingHere={standingHere}
            onSpeak={() => composeRef.current?.focus()}
          />
          </div>
        ) : null}
        {pixel ? (
          <div className="flex flex-1 items-start justify-center p-4 max-lg:order-1 max-lg:px-3">
            <PixelRoom
              roomSlug={data?.room.slug ?? room}
              capacity={data?.room.capacity ?? 40}
              nearby={data?.nearby ?? []}
              bubbles={roomBubbles}
              highlightId={whisperTo?.actor_id ?? null}
              onPickActor={
                me
                  ? (id) => {
                      const n = data?.nearby.find((x) => x.actor_id === id);
                      if (n && n.actor_id !== me.id) startWhisper(n);
                    }
                  : undefined
              }
            />
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-8 gap-2 p-6 content-start max-lg:order-1">
            {seats.map((n, i) => (
              <div key={i} className={`seat ${n ? "" : "seat-empty"}`}>
                {n ? (
                  <Link href={n.kind === "agent" ? `/a/${n.slug}` : `/u/${n.slug}`}>
                    <GeoAvatar kind={n.kind} seed={n.actor_id} size={28} label={false} />
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {room === "board" && board ? (
          <div className="max-lg:order-1 border-t border-lantern-400/20 bg-dusk-950/40 px-6 py-4">
            {/* The pin IS the board. One line per UTC day, claimed by whoever
                posts first; everything else is the pile underneath it. */}
            <h2 className="text-xs uppercase tracking-widest text-lantern-400">
              Pinned {board.day}
              {board.pin ? null : <span className="ml-2 normal-case tracking-normal text-white/40">— open, first post takes it</span>}
            </h2>
            {board.pin ? (
              <div className="mt-2 rounded-lg border border-sky-300/40 bg-sky-300/5 p-4">
                <div className="font-display text-xl text-sky-200">{board.pin.title}</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-white/80">{board.pin.body}</p>
                <p className="mt-2 text-[11px] text-white/40">
                  {board.pin.author_slug ? `@${board.pin.author_slug}` : board.pin.author_name ?? "someone since departed"}
                  {whenLabel(board.pin_opens_at) ? ` · holds for ${whenLabel(board.pin_opens_at)}` : null}
                </p>
              </div>
            ) : null}
            {board.posts.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {board.posts.map((n) => (
                  <li key={n.id} className="rounded-lg border border-white/10 bg-dusk-800/60 p-3">
                    <div className="font-semibold text-white/80">{n.title}</div>
                    <p className="mt-1 text-sm text-white/60">{n.body}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            {board.withheld > 0 ? (
              <p className="mt-3 text-[11px] text-white/35">
                {board.withheld} {board.withheld === 1 ? "notice is" : "notices are"} not shown to you.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="border-t border-white/10 p-4 max-lg:order-1">
          {whisperTo ? (
            <WhisperBar
              target={whisperTo}
              check={whisperCheck}
              inRoom={(data?.nearby ?? []).some((n) => n.actor_id === whisperTo.actor_id)}
              onCancel={stopWhisper}
            />
          ) : null}
          {room === "board" && !whisperTo ? (
            <input
              className="mb-2 w-full rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
              value={noticeTitle}
              onChange={(e) => setNoticeTitle(e.target.value)}
              placeholder="Pin title"
            />
          ) : null}
          <div className="flex gap-2">
            <input
              ref={composeRef}
              className={`min-w-0 flex-1 rounded-lg bg-dusk-800 px-3 py-2 ring-1 ${whisperTo ? "ring-violet-300/60" : "ring-white/10"}`}
              value={draft}
              aria-label={whisperTo ? `Whisper to ${nameFor(whisperTo)}` : "Speak in this room"}
              onChange={(e) => {
                const next = e.target.value;
                // "/w lantern " switches the box to a whisper as soon as the name is finished.
                const cmd = whisperTo ? null : parseWhisperCommand(next, data?.nearby ?? [], me?.id);
                if (cmd) startWhisper(cmd.target, cmd.rest);
                else setDraft(next);
              }}
              placeholder={
                whisperTo
                  ? `Whisper to ${nameFor(whisperTo)}…`
                  : room === "board"
                    ? "Notice body or room say…"
                    : "Speak in this room… (/w name to whisper)"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void say();
                else if (e.key === "Escape" && whisperTo) {
                  e.preventDefault();
                  stopWhisper();
                } else if (e.key === "Backspace" && whisperTo && draft === "") {
                  stopWhisper();
                }
              }}
            />
            <button
              onClick={say}
              disabled={
                Boolean(whisperTo) &&
                (sending || whisperCheck.status === "refused" || whisperCheck.status === "checking")
              }
              className={`shrink-0 rounded-full px-4 font-semibold text-dusk-950 disabled:cursor-not-allowed disabled:opacity-50 ${whisperTo ? "bg-violet-300" : "bg-lantern-400"}`}
            >
              {whisperTo ? "Whisper" : "Say"}
            </button>
            {room === "board" && !whisperTo ? (
              <button
                onClick={pinNotice}
                title={
                  board?.pin
                    ? "Today's pin is taken — this goes on the board unpinned. The slot opens again at 00:00 UTC."
                    : "Nobody has claimed today's pin. First post takes it."
                }
                className="rounded-full border border-lantern-400/40 px-4 text-lantern-300"
              >
                {board?.pin ? "Post" : "Claim pin"}
              </button>
            ) : null}
          </div>
          {mention ? (
            <p className="mt-2 text-xs text-white/50">
              That opens with @{mention.target.slug}, so the whole room hears it.{" "}
              <button
                type="button"
                onClick={() => startWhisper(mention.target, mention.rest)}
                className="rounded text-violet-200 underline decoration-violet-300/50 underline-offset-2 hover:text-violet-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
              >
                Whisper it to {nameFor(mention.target)} instead
              </button>
            </p>
          ) : null}
          {refusal ? <RefusalNotice input={refusal} /> : null}
          {err ? <p className="mt-2 text-sm text-red-300">{err}</p> : null}
        </div>
      </section>
      <aside className="flex flex-col border-l border-white/10">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-xs uppercase tracking-widest text-lantern-400">Who is here</h2>
          <RoomPresence
            nearby={data?.nearby ?? []}
            silencedActorIds={silencedActorIds}
            meId={me?.id}
            onWhisper={me ? (n) => (whisperTo?.actor_id === n.actor_id ? stopWhisper() : startWhisper(n)) : undefined}
            whisperTargetId={whisperTo?.actor_id ?? null}
          />
        </div>
        <div className="flex-1 overflow-auto p-4">
          <h2 className="text-xs uppercase tracking-widest text-lantern-400">Transcript</h2>
          {/* The canvas draws speech as bubbles; this is the same speech as
              text, and the carrier for anyone the canvas cannot reach. */}
          <ul className="mt-3 space-y-2 text-sm" role="log" aria-live="polite" aria-label="Transcript">
            {lines.length === 0 ? (
              <li key="empty-log" className="text-white/50">
                {emptyLog(data)}
              </li>
            ) : null}
            {log.map((entry) => {
              if (entry.kind === "whisper") {
                const w = entry.line;
                const other = nameOf.get(w.other_id) ?? (w.other_kind === "agent" ? "an agent, since gone" : "someone, since gone");
                const partner = (data?.nearby ?? []).find((n) => n.actor_id === w.other_id);
                return (
                  <li
                    key={`w-${w.id}`}
                    className="rounded-lg border border-violet-300/30 bg-violet-400/5 px-2 py-1.5"
                  >
                    <span className="mr-1.5 rounded bg-violet-300/20 px-1 py-px text-[9px] font-bold uppercase tracking-widest text-violet-200">
                      {w.direction === "out" ? "whisper" : "whispered"}
                    </span>
                    <span className="mr-1.5 font-semibold text-violet-200">
                      {w.direction === "out" ? `you → ${other}` : `${other} → you`}
                    </span>
                    <span className="italic text-white/85">{w.body}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-white/40">
                      <span>only you two</span>
                      {w.direction === "in" && partner && whisperTo?.actor_id !== partner.actor_id ? (
                        <button
                          type="button"
                          onClick={() => startWhisper(partner)}
                          className="rounded text-violet-200 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                        >
                          whisper back
                        </button>
                      ) : null}
                    </span>
                    {w.undelivered ? <RefusalNotice input={w.undelivered} /> : null}
                  </li>
                );
              }
              const l = entry.line;
              return (
              <li key={l.id}>
                <span className="grove-kind">{l.sender_kind === "agent" ? "AGENT" : "HUMAN"}</span>
                {/* A line with no name attached is not a conversation. The roster
                    is the only source of names, so a speaker who has walked out
                    is said to have walked out rather than quietly relabelled. */}
                <span className="mr-1.5 font-semibold text-lantern-300/80">
                  {l.sender_id === me?.id
                    ? "you"
                    : nameOf.get(l.sender_id) ??
                      (l.sender_kind === "agent" ? "an agent, since gone" : "someone, since gone")}
                </span>
                {l.body}
                <Reactions
                  target={{ kind: "speech", id: l.id }}
                  summary={l.reactions}
                  canReact={Boolean(me)}
                  onChange={(next) =>
                    setLines((cur) => cur.map((x) => (x.id === l.id ? { ...x, reactions: next } : x)))
                  }
                />
              </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </main>
  );
}

/**
 * "the Plaza", but "walkthrough's lounge" — an owner lounge is named after its
 * owner and takes no article, and every other room takes one.
 */
function theRoom(name: string): string {
  return name.includes("'s ") ? name : `the ${name}`;
}

function whenLabel(until: string | null): string | null {
  if (!until) return null;
  const ms = Date.parse(until) - Date.now();
  if (Number.isNaN(ms)) return null;
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * An empty transcript used to claim lantern was on a Plaza bench whether or not
 * it was. Say who is actually standing here instead, and say nothing about a
 * bench when nobody is on one.
 */
function emptyLog(data: RoomPayload | null): string {
  const agents = (data?.nearby ?? []).filter((n) => n.kind === "agent");
  if (agents.length === 0) {
    return "Nothing has been said here. Whatever you say waits for whoever comes next.";
  }
  const names = agents.map((a) => a.display_name || a.slug);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Nothing said yet, but ${list} ${names.length === 1 ? "is" : "are"} standing here. Say hello.`;
}

/**
 * The civic core is the commons and narrows nobody, so it is not even fetched.
 * Any other space requires membership to stand in at all (assertWorldAccess), so
 * the member-only roster will be populated here; a failure returns null and
 * `spaceSilencedActorIds()` then claims nothing rather than guessing.
 */
async function loadSpace(room: RoomWithWorld): Promise<SpaceSilenceSource | null> {
  const worldId = room.world_id;
  if (!worldId || worldId === CIVIC_CORE_WORLD_ID) return null;
  try {
    return await api<SpaceSilenceSource>(`/api/v1/worlds/${encodeURIComponent(worldId)}`);
  } catch {
    return null;
  }
}
