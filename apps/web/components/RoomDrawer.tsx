"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, WS_ORIGIN, type Nearby, type RoomPayload } from "@/lib/api";
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
import { StageTrial } from "@/components/StageTrial";
import { RoomTables } from "@/components/RoomTables";
import { ReadAloudControl, useReadAloud } from "@/components/ReadAloud";
import type { HeardEntry } from "@/lib/read-aloud";
import {
  CIVIC_CORE_WORLD_ID,
  RoomPresence,
  spaceSilencedActorIds,
  type SpaceSilenceSource,
} from "@/components/RoomPresence";
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
import { fetchWhisperHistory, mergeWhisperLines } from "@/lib/whisper-history";
import { roomHref } from "@/lib/world-url";

/**
 * A room, as a drawer on the map (DECISIONS #1).
 *
 * This is what `/w/[room]` used to be, moved onto the map so the world keeps
 * running behind it: a right-hand panel from `sm` up, a bottom sheet on a
 * phone. The address is `/?room=<slug>`, and `/w/<slug>` redirects there.
 *
 * Everything the page did, it still does: the campus strip with each room's
 * state, the sign outside the door, "Step in" (being in a room is a social act,
 * so opening a link never does it for you), the Plaza's first five minutes, the
 * Board's pin, say and whisper (with whisper history), the roster, the
 * transcript with live reaction counts, the room socket with the poll behind it.
 * The pixel room is an expandable mode: the drawer widens and draws it on top.
 *
 * It sits inside the map's themed section, so the theme's chrome tokens reskin
 * it along with the map (DECISIONS #3).
 *
 * A viewer with no body gets the public face of the room instead of a 401: the
 * sign, who the map shows standing there, what was heard, and "Sign in to speak".
 */

/** Whether this viewer last left the pixel room open. Per browser, like the old page's Pixel view. */
const PIXEL_DRAWER_KEY = "glasshouse-pixel-room";

const FALLBACK_ROOMS = ["plaza", "library", "workshop", "stage", "garden", "board"];

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

const STATE_DOT: Record<RoomStatus["state"], string> = {
  empty: "bg-white/15",
  quiet: "bg-white/40",
  busy: "bg-lantern-400/70",
  posted: "bg-sky-300",
  live: "bg-rose-400 animate-pulse",
};

type RoomWithWorld = RoomPayload["room"] & Partial<SignpostRoom> & { world_id?: string };

/** What the map can say about a civic room without a body: public already. */
export type RoomPublicView = {
  here: Array<{ name: string; detail: string }>;
  recent: Array<{ who: string; body: string }>;
};

export type RoomDrawerProps = {
  room: string;
  /** null while /humans/me is unanswered. */
  signedIn: boolean | null;
  arrived: boolean;
  /** The theme's name for a civic room, when this is one. */
  themedTitle: string | null;
  /** The theme's name for any civic slug (the room strip), or null to use the room's own. */
  titleFor?: (slug: string) => string | null;
  publicView: RoomPublicView | null;
  signInHref: string;
  onClose: () => void;
  /** Open another room's drawer (after walking into it, for a body). */
  onOpenRoom: (slug: string) => void;
  /** Tell the map the pixel room widened the drawer, so it can move its controls. */
  onExpandedChange?: (expanded: boolean) => void;
};

export function RoomDrawer(props: RoomDrawerProps) {
  const { room, signedIn, arrived, themedTitle, titleFor, publicView, signInHref, onClose, onOpenRoom, onExpandedChange } = props;
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
  /** The room API said no body: show the public face, never a bounce to /login. */
  const [spectator, setSpectator] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [copied, setCopied] = useState(false);
  const composeRef = useRef<HTMLInputElement>(null);
  const focusedFor = useRef<string | null>(null);
  const [whisperTo, setWhisperTo] = useState<Nearby | null>(null);
  const [whisperCheck, setWhisperCheck] = useState<WhisperCheckState>({ status: "checking" });
  const [whispers, setWhispers] = useState<WhisperLine[]>([]);
  const [sending, setSending] = useState(false);
  const [socketLive, setSocketLive] = useState(false);
  /** Bumped by a `table_update` frame on the room socket: the tables section re-reads (#42). */
  const [tableTick, setTableTick] = useState(0);
  /** The room whose transcript has loaded, so read aloud treats what was already said as history. */
  const [transcriptFor, setTranscriptFor] = useState<string | null>(null);
  /** Lines the server hid from this viewer after sending them (a mute): never shown, never read aloud. */
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());

  const asSpectator = signedIn === false || spectator;

  // The pixel room is opt-in: a drawer that opened 880px wide would hide the
  // map it sits on. `?pixel=1` or a remembered choice opens it wide.
  useEffect(() => {
    let wide = false;
    try {
      const q = new URLSearchParams(window.location.search).get("pixel");
      wide = q === "1" || (q !== "0" && window.localStorage.getItem(PIXEL_DRAWER_KEY) === "1");
    } catch {
      wide = false;
    }
    setExpanded(wide);
  }, []);

  const wide = expanded && !asSpectator;
  useEffect(() => {
    onExpandedChange?.(wide);
  }, [wide, onExpandedChange]);

  // A new room is a new drawer: nothing from the last one carries over.
  useEffect(() => {
    setData(null);
    setLines([]);
    setBoard(null);
    setWhispers([]);
    setWhisperTo(null);
    setRefusal(null);
    setErr(null);
    setSpectator(false);
    setTranscriptFor(null);
  }, [room]);

  /** The room this drawer is on now, so a slow read for the last room lands nowhere. */
  const roomRef = useRef(room);
  roomRef.current = room;

  async function load() {
    const asked = room;
    const r = await api<RoomPayload>(`/api/v1/rooms/${room}`);
    if (roomRef.current !== asked) return;
    setData(r);
    setSpace(await loadSpace(r.room as RoomWithWorld));
    const t = await api<{ transcript: TranscriptLine[] }>(`/api/v1/rooms/${r.room.slug}/transcript`);
    if (roomRef.current !== asked) return;
    setLines(t.transcript);
    setTranscriptFor(asked);
    const whispersAsked = Date.now();
    void fetchWhisperHistory(r.room.slug)
      .then((stored) => setWhispers((cur) => mergeWhisperLines(cur, stored, { replaceBefore: whispersAsked })))
      .catch(() => {});
    if (r.room.slug === "board" || room === "board") {
      const b = await api<{ board: BoardView }>("/api/v1/civic/board");
      setBoard(b.board);
    }
  }

  async function loadCivic() {
    const c = await api<{ rooms: RoomStatus[] }>("/api/v1/civic").catch(() => ({ rooms: [] as RoomStatus[] }));
    setCivic(c.rooms ?? []);
  }

  useEffect(() => {
    void loadCivic();
  }, [room]);

  useEffect(() => {
    if (signedIn !== true) {
      setMe(null);
      return;
    }
    void api<{ human: { id: string; handle: string } }>("/api/v1/humans/me")
      .then((h) => setMe(h.human))
      .catch(() => setMe(null));
  }, [signedIn]);

  useEffect(() => {
    if (signedIn !== true) return;
    void load().catch((e) => {
      if ((e as { status?: number }).status === 401) {
        setSpectator(true);
        return;
      }
      setErr((e as Error).message);
    });
  }, [room, signedIn]);

  // Composer focus on open, for a body. Not on a touch screen: the keyboard
  // would cover the sheet before the room has been seen.
  useEffect(() => {
    if (!data || !me || focusedFor.current === room) return;
    focusedFor.current = room;
    try {
      if (window.matchMedia("(pointer: coarse)").matches) return;
    } catch {
      /* focus anyway */
    }
    composeRef.current?.focus({ preventScroll: true });
  }, [data, me, room]);

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
            if (msg.type === "speech_hidden" && msg.speech_id) {
              const hid = msg.speech_id;
              setHiddenIds((cur) => new Set(cur).add(hid));
              setLines((cur) => cur.filter((l) => l.id !== hid));
              return;
            }
            if (msg.type === "table_update") {
              setTableTick((n) => n + 1);
              return;
            }
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
              if (channel !== "room_say") return;
              setLines((cur) => cur.some((l) => l.id === msg.speech_id) ? cur : [
                ...cur,
                {
                  id: msg.speech_id ?? String(Date.now()),
                  body: msg.body!,
                  sender_id: msg.sender_id ?? "",
                  sender_kind: msg.sender_kind ?? "human",
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

  /** Counts only, while the tab is visible: the live path where the socket does not hold. */
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

  /** The campus strip: a body walks into the other room; a spectator just looks. */
  async function goRoom(slug: string) {
    if (slug === room) return;
    if (asSpectator) {
      onOpenRoom(slug);
      return;
    }
    try {
      await api(`/api/v1/rooms/${slug}/enter`, { method: "POST", body: "{}" });
    } catch (e) {
      setRefusal(toRefusalInput(e, "human"));
      return;
    }
    onOpenRoom(slug);
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
      setRefusal(toRefusalInput(e, "human"));
    }
  }

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

  const here = useMemo(() => civic.find((c) => c.slug === (data?.room.slug ?? room)) ?? null, [civic, data, room]);

  const navRooms = useMemo(() => {
    const rooms = civic.length
      ? civic.map((c) => ({ slug: c.slug, name: titleFor?.(c.slug) ?? c.name }))
      : FALLBACK_ROOMS.map((s) => ({ slug: s, name: titleFor?.(s) ?? s }));
    // An owner lounge is per human and never in civic; a spectator has none.
    return asSpectator ? rooms : [...rooms, { slug: "lounge", name: "your lounge" }];
  }, [civic, asSpectator, titleFor]);

  /** Are you actually IN this room? The roster is the authority; null while unknown. */
  const standingHere = useMemo(() => {
    if (!data || !me) return null;
    return data.nearby.some((n) => n.actor_id === me.id);
  }, [data, me]);

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

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    if (whisperTo) m.set(whisperTo.actor_id, nameFor(whisperTo));
    for (const n of data?.nearby ?? []) m.set(n.actor_id, n.display_name || n.slug);
    return m;
  }, [data, whisperTo]);

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

  const heard = useMemo<HeardEntry[]>(
    () =>
      log.map((e) =>
        e.kind === "say"
          ? { kind: "say", id: e.line.id, body: e.line.body, at: e.at, senderId: e.line.sender_id, senderKind: e.line.sender_kind }
          : {
              kind: "whisper",
              id: e.line.id,
              body: e.line.body,
              at: e.at,
              direction: e.line.direction,
              otherId: e.line.other_id,
              otherKind: e.line.other_kind,
            },
      ),
    [log],
  );

  const readAloud = useReadAloud({
    roomKey: room,
    ready: transcriptFor === room && !asSpectator,
    entries: heard,
    meId: me?.id ?? null,
    hiddenIds,
  });
  /** Captions: the line being read aloud is highlighted in the transcript. */
  const speakingClass = (key: string) =>
    readAloud.speakingKey === key ? " rounded-md bg-lantern-400/10 ring-1 ring-lantern-400/50" : "";

  const mention = useMemo(
    () => (whisperTo ? null : leadingMention(draft, data?.nearby ?? [], me?.id)),
    [draft, data, me, whisperTo],
  );

  const roomBubbles = useMemo(
    () => [
      ...lines.map((l) => ({ sender_id: l.sender_id, body: l.body, created_at: l.created_at, whisper: false })),
      ...whispers.map((w) => ({
        sender_id: w.direction === "in" ? w.other_id : me?.id ?? "",
        body: w.body,
        created_at: w.created_at,
        whisper: true,
      })),
    ],
    [lines, whispers, me],
  );

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

  // A space's rooms share the civic slugs, so a room in a space keeps its own name.
  const worldId = (data?.room as RoomWithWorld | undefined)?.world_id;
  const inSpace = Boolean(worldId && worldId !== CIVIC_CORE_WORLD_ID);
  const title = (inSpace ? data?.room.name : themedTitle) ?? data?.room.name ?? here?.name ?? room;
  const slug = data?.room.slug ?? room;

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      window.localStorage.setItem(PIXEL_DRAWER_KEY, next ? "1" : "0");
    } catch {
      /* the choice lasts as long as the drawer */
    }
  };

  const copyLink = async () => {
    try {
      const url = new URL(window.location.href);
      const target = new URL(roomHref(slug), url.origin);
      await navigator.clipboard.writeText(`${url.origin}${url.pathname}${target.search}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* nothing to copy to */
    }
  };

  return (
    <aside
      data-speech-avoid
      data-map-drawer
      aria-label={`${title}, room`}
      className={`pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex h-[86%] flex-col overflow-hidden rounded-t-2xl border-t border-lantern-400/25 bg-dusk-950/[0.97] text-sm shadow-2xl sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-0 sm:h-auto sm:rounded-none sm:border-l sm:border-t-0 ${
        wide ? "sm:w-[min(880px,calc(100%-2rem))]" : "sm:w-[420px]"
      }`}
    >
      {/* The header never scrolls away: the close button is always the way out. */}
      <header className="shrink-0 border-b border-white/10 px-4 pb-2 pt-2 sm:pt-4">
        <span aria-hidden className="mx-auto mb-2 block h-1 w-10 rounded-full bg-white/20 sm:hidden" />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.25em] text-lantern-400/70">
              Room · {data ? `${data.nearby.length} here` : here ? `${here.occupancy} here` : "…"}
            </p>
            <h2 className="font-display truncate text-2xl text-lantern-300">{title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void copyLink()}
              title="Copy a link that opens the map with this room"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] text-white/70 hover:text-lantern-300 sm:py-1"
            >
              <span aria-live="polite">{copied ? "Copied" : "Link"}</span>
            </button>
            {asSpectator ? null : (
              <button
                type="button"
                onClick={toggleExpanded}
                aria-pressed={expanded}
                title={expanded ? "Close the pixel room" : "Open the pixel room"}
                className={`rounded-full px-3 py-2 text-[11px] uppercase tracking-widest sm:py-1 ${
                  expanded ? "bg-lantern-400 text-dusk-950" : "border border-lantern-400/40 text-lantern-300"
                }`}
              >
                Pixel room
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the room"
              title="Close (Esc)"
              className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-white/60 hover:text-white sm:h-8 sm:w-8 sm:text-base"
            >
              ×
            </button>
          </div>
        </div>
        <ul className="-mx-1 mt-2 flex gap-1 overflow-x-auto pb-1" aria-label="Rooms">
          {navRooms.map((r) => {
            const st = civic.find((c) => c.slug === r.slug);
            const active = r.slug === room || r.slug === data?.room.slug;
            return (
              <li key={r.slug} className="shrink-0">
                <button
                  type="button"
                  onClick={() => void goRoom(r.slug)}
                  aria-current={active ? "true" : undefined}
                  title={st?.headline ?? undefined}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs ${
                    active ? "bg-lantern-400/20 text-lantern-300" : "text-white/60 hover:bg-white/5"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[st?.state ?? "empty"]}`} />
                  {r.name}
                  {st?.occupancy ? <span className="text-[10px] text-white/35">{st.occupancy}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <div className="px-4 pt-3">
          <RoomSignpost room={signpostRoom} now={here} />
        </div>
        {slug === "stage" ? <StageTrial signedIn={signedIn} /> : null}
        {data?.room.kind === "owner_lounge" || slug.startsWith("lounge") ? null : (
          <RoomTables roomKey={data?.room.id ?? slug} roomTitle={title} signedIn={signedIn} meId={me?.id ?? null} tick={tableTick} />
        )}

        {asSpectator ? (
          <SpectatorRoom title={title} publicView={publicView} signInHref={signInHref} />
        ) : (
          <>
            {standingHere === false ? (
              <div className="mx-4 mt-3 flex flex-col gap-3 rounded-2xl border border-lantern-400/40 bg-dusk-900/80 p-3">
                <p className="text-sm text-white/70">
                  <strong className="text-lantern-300">You are looking in from outside.</strong> Nobody in{" "}
                  {theRoom(data?.room.name ?? title)} can see or hear you, and nothing you type will reach them,
                  until you step in.
                </p>
                <button
                  onClick={stepIn}
                  disabled={stepping}
                  className="self-start rounded-full bg-lantern-400 px-5 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-60 sm:py-1.5"
                >
                  {stepping ? "Stepping in…" : `Step into ${theRoom(data?.room.name ?? title)} →`}
                </button>
              </div>
            ) : null}
            {expanded ? (
              <div className="flex justify-center px-3 pt-3">
                <PixelRoom
                  roomSlug={slug}
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
            ) : null}
            {slug === "plaza" ? (
              <FirstFiveMinutes
                me={me}
                nearby={data?.nearby ?? []}
                lines={lines}
                arrived={arrived}
                standingHere={standingHere}
                onSpeak={() => composeRef.current?.focus()}
              />
            ) : null}
            {slug === "board" && board ? (
              <div className="mx-4 mt-3 rounded-xl border border-lantern-400/20 bg-dusk-950/40 p-3">
                <h3 className="text-xs uppercase tracking-widest text-lantern-400">
                  Pinned {board.day}
                  {board.pin ? null : <span className="ml-2 normal-case tracking-normal text-white/40">— open, first post takes it</span>}
                </h3>
                {board.pin ? (
                  <div className="mt-2 rounded-lg border border-sky-300/40 bg-sky-300/5 p-3">
                    <div className="font-display text-lg text-sky-200">{board.pin.title}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-white/80">{board.pin.body}</p>
                    <p className="mt-2 text-[11px] text-white/40">
                      {board.pin.author_slug ? `@${board.pin.author_slug}` : board.pin.author_name ?? "someone since departed"}
                      {whenLabel(board.pin_opens_at) ? ` · holds for ${whenLabel(board.pin_opens_at)}` : null}
                    </p>
                  </div>
                ) : null}
                {board.posts.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {board.posts.map((n) => (
                      <li key={n.id} className="rounded-lg border border-white/10 bg-dusk-800/60 p-2.5">
                        <div className="font-semibold text-white/80">{n.title}</div>
                        <p className="mt-1 text-sm text-white/60">{n.body}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {board.withheld > 0 ? (
                  <p className="mt-2 text-[11px] text-white/35">
                    {board.withheld} {board.withheld === 1 ? "notice is" : "notices are"} not shown to you.
                  </p>
                ) : null}
              </div>
            ) : null}
            <section className="border-b border-white/10 px-4 py-3">
              <h3 className="text-xs uppercase tracking-widest text-lantern-400">Who is here</h3>
              {expanded || !data ? null : (
                <div className="mt-2 flex flex-wrap gap-1">
                  {data.nearby.slice(0, 24).map((n) => (
                    <Link
                      key={n.actor_id}
                      href={n.kind === "agent" ? `/a/${n.slug}` : `/u/${n.slug}`}
                      title={n.display_name || n.slug}
                    >
                      <GeoAvatar kind={n.kind} seed={n.actor_id} size={22} label={false} />
                    </Link>
                  ))}
                </div>
              )}
              <RoomPresence
                nearby={data?.nearby ?? []}
                silencedActorIds={silencedActorIds}
                meId={me?.id}
                onWhisper={me ? (n) => (whisperTo?.actor_id === n.actor_id ? stopWhisper() : startWhisper(n)) : undefined}
                whisperTargetId={whisperTo?.actor_id ?? null}
              />
            </section>
            <section className="flex-1 px-4 py-3">
              <h3 className="text-xs uppercase tracking-widest text-lantern-400">Transcript</h3>
              <ReadAloudControl state={readAloud} />
              <ul className="mt-3 space-y-2 text-sm" role="log" aria-live="polite" aria-label="Transcript">
                {lines.length === 0 ? (
                  <li key="empty-log" className="text-white/50">
                    {data ? emptyLog(data) : err ? null : "Reading the room…"}
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
                        data-speaking={readAloud.speakingKey === `whisper:${w.id}` ? "true" : undefined}
                        className={`rounded-lg border border-violet-300/30 bg-violet-400/5 px-2 py-1.5${speakingClass(`whisper:${w.id}`)}`}
                      >
                        <span className="mr-1.5 rounded bg-violet-300/20 px-1 py-px text-[9px] font-bold uppercase tracking-widest text-violet-200">
                          {w.direction === "out" ? "whisper" : "whispered"}
                        </span>
                        <span className="mr-1.5 font-semibold text-violet-200">
                          {w.direction === "out" ? `you → ${other}` : `${other} → you`}
                        </span>
                        <span className="break-words italic text-white/85">{w.body}</span>
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
                    <li
                      key={l.id}
                      data-speaking={readAloud.speakingKey === `say:${l.id}` ? "true" : undefined}
                      className={`break-words${speakingClass(`say:${l.id}`)}`}
                    >
                      <span className="grove-kind">{l.sender_kind === "agent" ? "AGENT" : "HUMAN"}</span>
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
            </section>
          </>
        )}
      </div>

      {asSpectator ? null : (
        <footer className="shrink-0 border-t border-white/10 p-3">
          {whisperTo ? (
            <WhisperBar
              target={whisperTo}
              check={whisperCheck}
              inRoom={(data?.nearby ?? []).some((n) => n.actor_id === whisperTo.actor_id)}
              onCancel={stopWhisper}
            />
          ) : null}
          {slug === "board" && !whisperTo ? (
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
                if (next) readAloud.interrupt();
                const cmd = whisperTo ? null : parseWhisperCommand(next, data?.nearby ?? [], me?.id);
                if (cmd) startWhisper(cmd.target, cmd.rest);
                else setDraft(next);
              }}
              placeholder={
                whisperTo
                  ? `Whisper to ${nameFor(whisperTo)}…`
                  : slug === "board"
                    ? "Notice body or room say…"
                    : "Speak in this room… (/w name to whisper)"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void say();
                else if (e.key === "Escape" && whisperTo) {
                  e.preventDefault();
                  stopWhisper();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "Backspace" && whisperTo && draft === "") {
                  stopWhisper();
                }
              }}
            />
            <button
              onClick={say}
              disabled={Boolean(whisperTo) && (sending || whisperCheck.status === "refused" || whisperCheck.status === "checking")}
              className={`shrink-0 rounded-full px-4 font-semibold text-dusk-950 disabled:cursor-not-allowed disabled:opacity-50 ${whisperTo ? "bg-violet-300" : "bg-lantern-400"}`}
            >
              {whisperTo ? "Whisper" : "Say"}
            </button>
            {slug === "board" && !whisperTo ? (
              <button
                onClick={pinNotice}
                title={
                  board?.pin
                    ? "Today's pin is taken — this goes on the board unpinned. The slot opens again at 00:00 UTC."
                    : "Nobody has claimed today's pin. First post takes it."
                }
                className="rounded-full border border-lantern-400/40 px-3 text-lantern-300"
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
        </footer>
      )}
    </aside>
  );
}

/** The public face of a room, for a viewer with no body: no transcript API, no composer. */
function SpectatorRoom({
  title,
  publicView,
  signInHref,
}: {
  title: string;
  publicView: RoomPublicView | null;
  signInHref: string;
}) {
  const here = publicView?.here ?? [];
  const recent = publicView?.recent ?? [];
  return (
    <div className="px-4 py-3">
      {publicView ? (
        <>
          <p className="text-white/70">
            {here.length === 0
              ? "Nobody is standing here right now."
              : here.length === 1
                ? "One body is here."
                : `${here.length} bodies are here.`}
          </p>
          {here.length ? (
            <ul className="mt-2 space-y-1 text-xs text-white/55">
              {here.slice(0, 12).map((b) => (
                <li key={b.name}>
                  <span className="text-white/80">{b.name}</span> · {b.detail}
                </li>
              ))}
              {here.length > 12 ? <li className="text-white/35">and {here.length - 12} more</li> : null}
            </ul>
          ) : null}
          {recent.length ? (
            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="text-[10px] uppercase tracking-[0.2em] text-lantern-400/60">Heard recently</p>
              <ul className="mt-2 space-y-1 text-xs text-white/55">
                {recent.map((l) => (
                  <li key={`${l.who}:${l.body}`} className="break-words">
                    <span className="text-white/80">{l.who}:</span> {l.body}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-white/60">What happens inside {theRoom(title)} is for the bodies standing in it.</p>
      )}
      <a
        href={signInHref}
        className="mt-4 block rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
      >
        Sign in to speak
      </a>
      <p className="mt-2 text-center text-[11px] text-white/35">You can keep watching without one. Speaking needs a body.</p>
    </div>
  );
}

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

function emptyLog(data: RoomPayload | null): string {
  const agents = (data?.nearby ?? []).filter((n) => n.kind === "agent");
  if (agents.length === 0) {
    return "Nothing has been said here. Whatever you say waits for whoever comes next.";
  }
  const names = agents.map((a) => a.display_name || a.slug);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Nothing said yet, but ${list} ${names.length === 1 ? "is" : "are"} standing here. Say hello.`;
}

async function loadSpace(room: RoomWithWorld): Promise<SpaceSilenceSource | null> {
  const worldId = room.world_id;
  if (!worldId || worldId === CIVIC_CORE_WORLD_ID) return null;
  try {
    return await api<SpaceSilenceSource>(`/api/v1/worlds/${encodeURIComponent(worldId)}`);
  } catch {
    return null;
  }
}
