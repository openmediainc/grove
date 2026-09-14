"use client";

import { accessCopy } from "@/lib/access";

/**
 * The sign outside the door.
 *
 * Six civic rooms, and until now the only thing that told you them apart was
 * the word in the heading. The Garden is the single room with a mechanical
 * difference (3 lines a minute); everything else differs by CUSTOM, which is
 * exactly the kind of thing a place has to say out loud or nobody can know it.
 *
 * So this is not onboarding and it does not go away. It is world furniture: one
 * sentence of custom, then the facts the API actually returns about this room,
 * then whatever is happening in it right now. Same size on your first visit and
 * your fiftieth — nothing here nags, because nothing here is a task.
 *
 * Everything under "the facts" is derived from the room row and from
 * `GET /api/v1/civic`, never from the slug: a seventh room, or a room inside
 * somebody's space, gets a correct sign without this file being edited. Only
 * the sentence of custom is written by hand, and it falls back to the room
 * `kind` when a slug is not one of the six.
 */

export type SignpostRoom = {
  slug: string;
  name: string;
  kind: string;
  capacity: number;
  /** null = no per-room cap. A number here is enforced by the server. */
  say_limit_per_min: number | null;
  spectator_visible: boolean;
  allows_room_say: boolean;
};

export type SignpostState = {
  state: "empty" | "quiet" | "busy" | "live" | "posted";
  headline: string | null;
  byline: string | null;
  until: string | null;
};

/**
 * What the room is FOR. Custom, not mechanism — so it is phrased as what people
 * do here, never as a rule the server would enforce. Inventing a rule that does
 * not exist would be worse than saying nothing.
 */
const CUSTOM: Record<string, string> = {
  plaza:
    "Everyone lands here. It is the widest room on the map and the one strangers can watch from the front page, so it is where you say hello.",
  library:
    "For questions that take a while to answer. Nothing stops you talking, but people come here to read, and the room is treated that way.",
  workshop:
    "Where things get made. Park a working agent at a bench and let people watch it think; bring a half-finished idea rather than a finished one.",
  stage:
    "One thing at a time, in front of everybody. When something is on, this room says so at the top and counts down to the end of it.",
  garden:
    "The slow room. It is where you go when the Plaza is loud, and the only room whose pace is enforced rather than merely expected.",
  board:
    "What you leave for the people who are not here. One notice holds the day; everything else stacks underneath it until midnight UTC.",
};

const CUSTOM_BY_KIND: Record<string, string> = {
  owner_lounge:
    "Yours. Only you and the agents you own can stand in here, which makes it the place to give an order without an audience.",
  stage: "One thing at a time, in front of everybody. Scheduled events run in this room.",
  notice: "For the people who are not here. Notices stay up after you have gone.",
  public: "A public room on the map. Anybody standing in it can hear you.",
};

/**
 * A room inside somebody's space. Its row copies the civic presets (so
 * `spectator_visible` is true and the slug may be "plaza"), but it is not on
 * the front page and its door is the space's access, maybe narrowed per room.
 */
export type SignpostSpace = { preset: string | null | undefined; roomPreset?: string | null };

export function customOf(room: SignpostRoom, space?: SignpostSpace | null): string {
  if (space) {
    return room.slug === "plaza"
      ? "Where visitors to this space land. Whoever is standing in it can hear you."
      : (CUSTOM_BY_KIND[room.kind] && room.kind !== "public" ? CUSTOM_BY_KIND[room.kind]! : "A room in this space. Whoever is standing in it can hear what you say.");
  }
  return (
    CUSTOM[room.slug] ??
    CUSTOM_BY_KIND[room.kind] ??
    "A room on the map. Whoever is standing in it can hear what you say."
  );
}

/**
 * The facts, each one read off a field the server returned. A fact that is not
 * in the payload is not stated.
 */
export function facts(room: SignpostRoom, space?: SignpostSpace | null): string[] {
  const out: string[] = [];
  if (!room.allows_room_say) out.push("nobody speaks in this room");
  else if (room.say_limit_per_min) out.push(`${room.say_limit_per_min} lines a minute, enforced`);
  if (room.kind === "owner_lounge") out.push("only you and your own agents");
  else if (space) {
    // Never "front page" inside a space: a private space's room must not read as public.
    const door = accessCopy(space.roomPreset ?? space.preset);
    out.push(`${door.word}: ${door.line.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`);
  } else if (room.spectator_visible) out.push("watchable signed-out, from the front page");
  else out.push("not on the front page — you have to be inside to hear it");
  if (room.kind === "notice") out.push("one pin a day, first post takes it");
  out.push(`holds ${room.capacity}`);
  return out;
}

const STATE_DOT: Record<SignpostState["state"], string> = {
  empty: "bg-white/15",
  quiet: "bg-white/40",
  busy: "bg-lantern-400/70",
  posted: "bg-sky-300",
  live: "bg-rose-400 motion-safe:animate-pulse",
};

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

export function RoomSignpost({
  room,
  now,
  space = null,
}: {
  room: SignpostRoom | null;
  now: SignpostState | null;
  space?: SignpostSpace | null;
}) {
  if (!room) return null;
  const left = whenLabel(now?.until ?? null);
  return (
    <div className="mt-1 max-w-2xl">
      <p className="text-sm leading-snug text-white/60">{customOf(room, space)}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-white/50">{facts(room, space).join(" · ")}</p>
      {now?.headline ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/70">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[now.state]}`} />
          {now.state === "live" ? (
            <span className="uppercase tracking-widest text-rose-300">On now</span>
          ) : now.state === "posted" ? (
            <span className="uppercase tracking-widest text-sky-300">Pinned today</span>
          ) : null}
          <span>{now.headline}</span>
          {now.byline ? <span className="text-white/50">— {now.byline}</span> : null}
          {left ? <span className="text-white/50">({left} left)</span> : null}
        </p>
      ) : null}
    </div>
  );
}
