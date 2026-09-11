"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState("grove-alpha");
  const [age, setAge] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) return;
    void (async () => {
      try {
        await api("/api/v1/humans/session/consume", { method: "POST", body: JSON.stringify({ token }) });
        window.location.href = "/enter";
      } catch (e) {
        setMsg((e as Error).message);
      }
    })();
  }, [params]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await api<{ dev_login_url?: string }>("/api/v1/humans/session", {
        method: "POST",
        body: JSON.stringify({ email, invite_code: invite, age_attested: age }),
      });
      setUrl(res.dev_login_url ?? null);
      setMsg(res.dev_login_url ? "Dev login URL ready (also printed in API logs)." : "Check your email.");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="font-display text-4xl text-lantern-300">Magic link</h1>
      <p className="mt-2 text-white/60">Closed alpha. Invite code and 18+ attestation required.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <label className="block text-sm">
          Email
          <input
            className="mt-1 w-full rounded-lg bg-dusk-800 px-3 py-2 outline-none ring-1 ring-white/10"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Invite code
          <input
            className="mt-1 w-full rounded-lg bg-dusk-800 px-3 py-2 outline-none ring-1 ring-white/10"
            required
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />I attest I am 18 or older.
        </label>
        <button className="w-full rounded-full bg-lantern-400 py-2 font-semibold text-dusk-950">Send link</button>
      </form>
      {msg ? <p className="mt-4 text-sm text-lantern-300">{msg}</p> : null}
      {url ? (
        <a className="mt-3 block break-all text-sm underline text-lantern-400" href={url}>
          {url}
        </a>
      ) : null}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
