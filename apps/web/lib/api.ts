import { GROVE_BASE, gp } from "./base";

export const WS_ORIGIN =
  process.env.NEXT_PUBLIC_WS_ORIGIN ??
  (typeof window !== "undefined" ? `${window.location.origin}${GROVE_BASE}` : `http://127.0.0.1:3510${GROVE_BASE}`);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(gp(path), {
    ...init,
    // Every write says JSON, body or not: the API reads an empty JSON body as
    // none (it used to refuse it, so board Delete 500'd), while a bodiless
    // POST with no content-type reached Fastify as an unsupported media type.
    headers: {
      ...(init?.body != null || (init?.method && !/^(GET|HEAD)$/i.test(init.method)) ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  const json = (await res.json()) as T & { ok?: boolean; error?: { message?: string; code?: string } };
  if (!res.ok) {
    throw Object.assign(new Error(json.error?.message ?? res.statusText), {
      status: res.status,
      code: json.error?.code,
      body: json,
    });
  }
  return json;
}

export type Nearby = {
  actor_id: string;
  kind: "human" | "agent";
  display_name: string;
  slug: string;
  badges: string[];
  owner_handle?: string;
  avatar_id?: string;
  presence: {
    seat_index: number;
    connection: string;
    mode: string;
    activity: string;
    room_id: string;
  };
};

export type RoomPayload = {
  room: { id: string; slug: string; name: string; kind: string; capacity: number; occupancy?: number };
  nearby: Nearby[];
};
