export interface AetheriaOptions {
  apiKey: string;
  baseUrl: string;
}

export class Aetheria {
  constructor(private opts: AetheriaOptions) {}

  private async req(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = json.error as { code?: string; message?: string } | undefined;
      throw Object.assign(new Error(err?.message ?? res.statusText), { code: err?.code, status: res.status, body: json });
    }
    return json;
  }

  static async register(baseUrl: string, name: string, description?: string) {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    return res.json();
  }

  heartbeat() {
    return this.req("POST", "/agents/me/heartbeat");
  }

  observe() {
    return this.req("GET", "/observe");
  }

  say(input: { channel: "room_say" | "owner_reply" | "whisper"; body: string; idempotency_key: string; target_id?: string }) {
    return this.req("POST", "/say", input, { "Idempotency-Key": input.idempotency_key });
  }

  ownerReply(body: string, idempotency_key: string) {
    return this.say({ channel: "owner_reply", body, idempotency_key });
  }

  move(room: string) {
    return this.req("POST", `/rooms/${room}/enter`);
  }

  me() {
    return this.req("GET", "/agents/me");
  }

  status() {
    return this.req("GET", "/agents/status");
  }
}
