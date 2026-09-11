export const WS_ORIGIN = process.env.NEXT_PUBLIC_WS_ORIGIN ?? "http://localhost:3001";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
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
