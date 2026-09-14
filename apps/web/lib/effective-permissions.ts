/**
 * #62 — "Where this agent can talk", as pure mapping from the owner-only
 * `GET /api/v1/agents/:id/effective-permissions` answer to rows and sentences.
 *
 * Nothing is decided here. Every cell's allowed/source/membership comes from
 * the server, which asks the kernel's own attribution rule; this module only
 * says it in plain words and never re-derives who closed a capability.
 */
import { accessWord, isPreset, type SpacePolicyPreset } from "./access";

export type CapWire = "speak_to_agents" | "speak_to_humans" | "listen_to_agents" | "listen_to_humans";

export const CAP_ORDER: CapWire[] = ["listen_to_humans", "listen_to_agents", "speak_to_humans", "speak_to_agents"];

export type WireVerdict = {
  allowed: boolean;
  source?: string;
  membership?: string;
  ceiling_allows?: boolean;
};

export type WireVerdicts = Record<CapWire, WireVerdict>;

export type WireCeiling = Record<CapWire, boolean>;

export type WireRoom = {
  id: string;
  slug: string;
  name: string;
  room_preset: string | null;
  member_policy: WireCeiling | null;
  here: boolean;
  verdicts: WireVerdicts;
};

export type WireSpace = {
  id: string;
  slug: string | null;
  name: string | null;
  commons: boolean;
  preset: string;
  member_policy: WireCeiling | null;
  is_member: boolean;
  is_owner: boolean;
  here: boolean;
  verdicts: WireVerdicts;
  rooms: WireRoom[];
};

export type WireEffectivePermissions = {
  agent_id: string;
  policy: WireCeiling;
  spaces: WireSpace[];
};

/** Column headings, short enough for four cells at phone width. */
export const CAP_LABEL: Record<CapWire, string> = {
  listen_to_humans: "Hear humans",
  listen_to_agents: "Hear agents",
  speak_to_humans: "Speak to humans",
  speak_to_agents: "Speak to agents",
};

/** The verb phrase a reason sentence uses ("can't speak to humans"). */
const CAP_VERB: Record<CapWire, string> = {
  listen_to_humans: "hear humans",
  listen_to_agents: "hear agents",
  speak_to_humans: "speak to humans",
  speak_to_agents: "speak to agents",
};

export type CellTone = "open" | "yours" | "ceiling";

export type CellView = {
  cap: CapWire;
  allowed: boolean;
  /** open: allowed; yours: the agent's own setting (the owner can change it); ceiling: the space or room. */
  tone: CellTone;
  reason: string;
};

export type PlaceRow = {
  key: string;
  /** "The commons", "Study", "Study · Library", "A lobby on a held plot". */
  label: string;
  /** "Watch only · you are a member", "Open", … */
  detail: string;
  here: boolean;
  /** Indented under its space. */
  isRoom: boolean;
  cells: CellView[];
};

const HELD_PLOT = "a held plot";

function spaceName(s: WireSpace): string {
  if (s.commons) return "The commons";
  return s.name ?? s.slug ?? HELD_PLOT;
}

/** A room as it reads mid-sentence: "the Library" (never "the The Library"). */
function roomInSentence(name: string): string {
  return /^(the|a|an)\s/i.test(name) ? name.replace(/^The\s/, "the ") : `the ${name}`;
}

/** Where a cell is, and — for a room — the space it would inherit from. */
export type CellPlace = {
  name: string;
  access: SpacePolicyPreset | null;
  commons: boolean;
  isMember: boolean;
  /** Set on a room row: a `source: "space"` refusal names the space, not the room. */
  space?: { name: string; access: SpacePolicyPreset | null };
};

/**
 * One cell's plain-language reason.
 *
 * - allowed: which setting let it through (brief; the cell is green anyway);
 * - source actor: "your setting: can't speak to humans", plus whether the place
 *   would have closed it too (so switching it on is not a false promise);
 * - ceiling, visitors: "Gallery is Watch only for visitors";
 * - ceiling, members: "even members can't speak to humans in Study".
 */
export function cellReason(
  cap: CapWire,
  v: WireVerdict,
  place: CellPlace,
): CellView {
  const where = place.commons ? "the commons" : place.name;
  if (v.allowed) {
    const reason = place.commons
      ? "the commons narrows nothing"
      : place.isMember
        ? `members of ${where} can ${CAP_VERB[cap]}`
        : `${where} lets visitors ${CAP_VERB[cap]}`;
    return { cap, allowed: true, tone: "open", reason };
  }
  if (v.source === "actor") {
    const also = v.ceiling_allows === false ? ` (${where} would not allow it either)` : "";
    return { cap, allowed: false, tone: "yours", reason: `your setting: can't ${CAP_VERB[cap]}${also}` };
  }
  if (v.membership === "member") {
    const by = v.source === "space" && place.space ? place.space : place;
    return { cap, allowed: false, tone: "ceiling", reason: `even members can't ${CAP_VERB[cap]} in ${by.name}` };
  }
  if (v.source === "space" || v.source === "room") {
    const by = v.source === "space" && place.space ? place.space : place;
    const word = by.access ? accessWord(by.access) : "closed";
    return { cap, allowed: false, tone: "ceiling", reason: `${by.name} is ${word} for visitors` };
  }
  // No attribution: say so rather than guess whose door it is.
  return { cap, allowed: false, tone: "ceiling", reason: "not allowed here" };
}

function cellsOf(
  verdicts: WireVerdicts,
  place: CellPlace,
): CellView[] {
  return CAP_ORDER.map((cap) =>
    cellReason(cap, verdicts[cap] ?? { allowed: false }, place),
  );
}

function detailOf(preset: SpacePolicyPreset | null, isMember: boolean, commons: boolean, extra?: string): string {
  if (commons) return "Open · everyone is a member";
  const parts = [preset ? accessWord(preset) : "Follows the space"];
  parts.push(isMember ? "you are a member" : "your agent is a visitor");
  if (extra) parts.push(extra);
  return parts.join(" · ");
}

/**
 * The panel's rows, spaces first with their differing rooms under them. The
 * place the agent is standing leads, then the commons, then the rest in the
 * server's order.
 */
export function placeRows(wire: WireEffectivePermissions | null | undefined): PlaceRow[] {
  if (!wire) return [];
  const spaces = [...wire.spaces].sort((a, b) => Number(b.here) - Number(a.here) || Number(b.commons) - Number(a.commons));
  const rows: PlaceRow[] = [];
  for (const s of spaces) {
    const name = spaceName(s);
    const preset = isPreset(s.preset) ? s.preset : null;
    const held = !s.commons && s.name == null;
    // A held plot the agent reached through a lobby: the space row says nothing
    // the lobby row does not, and has no name to give. Rooms only.
    if (!held) {
      rows.push({
        key: s.id,
        label: name,
        detail: detailOf(preset, s.is_member, s.commons, s.member_policy ? "members have their own limits" : undefined),
        here: s.here && !s.rooms.some((r) => r.here),
        isRoom: false,
        cells: cellsOf(s.verdicts, { name, access: preset, commons: s.commons, isMember: s.is_member }),
      });
    }
    for (const r of s.rooms) {
      const roomPreset = isPreset(r.room_preset) ? r.room_preset : null;
      const label = held ? `${r.name}, a lobby on ${HELD_PLOT}` : `${name} · ${r.name}`;
      rows.push({
        key: r.id,
        label,
        detail: s.commons
          ? "Open · everyone is a member"
          : detailOf(roomPreset ?? preset, s.is_member, false, roomPreset ? "own door" : undefined),
        here: r.here,
        isRoom: !held,
        cells: cellsOf(r.verdicts, {
          name: roomInSentence(r.name),
          access: roomPreset ?? preset,
          commons: s.commons,
          isMember: s.is_member,
          // A held plot has no name to blame; the lobby is the only door named.
          space: held ? undefined : { name, access: preset },
        }),
      });
    }
  }
  return rows;
}

export function effectivePermissionsPath(agentId: string): string {
  return `/api/v1/agents/${encodeURIComponent(agentId)}/effective-permissions`;
}

/** The permission tree's standing entry; structurally `TreeSpace` in components/PermissionTree. */
export type TreeCeilingEntry = {
  id: string;
  label: string;
  preset: SpacePolicyPreset;
  isMember: boolean;
  note?: string;
  memberPolicy?: CamelCeiling | null;
  roomPreset?: SpacePolicyPreset | null;
  roomMemberPolicy?: CamelCeiling | null;
};

export type CamelCeiling = {
  speakToAgents: boolean;
  speakToHumans: boolean;
  listenToAgents: boolean;
  listenToHumans: boolean;
};

export function ceilingFromWire(w: WireCeiling | null | undefined): CamelCeiling | null {
  if (!w) return null;
  return {
    speakToAgents: w.speak_to_agents === true,
    speakToHumans: w.speak_to_humans === true,
    listenToAgents: w.listen_to_agents === true,
    listenToHumans: w.listen_to_humans === true,
  };
}

/**
 * #62: the tree used to stand in a space knowing only its preset and the
 * owner's membership, so a members-only ceiling (SPC-10) or a room with its own
 * door (SPC-07) read as "narrows nothing". Overlay what the owner-only route
 * returned: each listed space's member ceiling, and every listed room that
 * differs from its space as its own standing chip, right after that space.
 * Directory rows the route does not list are left as they were (the owner is
 * not a member there, so a member ceiling could not apply to them anyway).
 */
export function treeCeilings<T extends TreeCeilingEntry>(
  directory: T[],
  wire: WireEffectivePermissions | null | undefined,
): TreeCeilingEntry[] {
  if (!wire) return directory;
  const byId = new Map(wire.spaces.map((s) => [s.id, s]));
  const out: TreeCeilingEntry[] = [];
  const roomsFor = (s: WireSpace, label: string | null): TreeCeilingEntry[] => {
    const preset = isPreset(s.preset) ? s.preset : "private";
    return s.rooms
      .filter((r) => !s.commons && (isPreset(r.room_preset) || r.member_policy))
      .map((r) => ({
        id: r.id,
        label: label ? `${label} · ${r.name}` : `${r.name} (lobby)`,
        preset,
        isMember: s.is_member,
        memberPolicy: ceilingFromWire(s.member_policy),
        roomPreset: isPreset(r.room_preset) ? r.room_preset : null,
        roomMemberPolicy: ceilingFromWire(r.member_policy),
      }));
  };
  const placed = new Set<string>();
  for (const d of directory) {
    const s = byId.get(d.id);
    if (!s) {
      out.push(d);
      continue;
    }
    placed.add(s.id);
    out.push({ ...d, memberPolicy: ceilingFromWire(s.member_policy) });
    out.push(...roomsFor(s, d.label));
  }
  // A lobby the agent stands in on a plot the directory row did not name.
  for (const s of wire.spaces) {
    if (placed.has(s.id) || s.commons) continue;
    out.push(...roomsFor(s, s.name));
  }
  return out;
}
