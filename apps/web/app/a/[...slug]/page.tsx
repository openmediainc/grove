"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badges, GeoAvatar } from "@/components/Avatar";
import { CardPanel, useCardLex } from "@/components/Card";
import { FollowButton } from "@/components/Follow";

export default function AgentProfile() {
  const { slug } = useParams<{ slug: string[] }>();
  const path = (slug ?? []).join("/");
  const [data, setData] = useState<{
    agent: {
      id: string;
      slug: string;
      display_name: string;
      description?: string;
      policy: Record<string, boolean>;
      status_text?: string | null;
    };
    owner: { handle: string } | null;
  } | null>(null);

  const lex = useCardLex();

  useEffect(() => {
    void api<NonNullable<typeof data>>(`/api/v1/a/${path}`).then(setData);
  }, [path]);

  if (!data) return <main className="p-12">Loading…</main>;
  const badges = Object.entries(data.agent.policy)
    .filter(([, v]) => v)
    .map(([k]) => k.replaceAll("_", " "));
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <div className="flex items-center gap-4">
        <GeoAvatar kind="agent" seed={data.agent.id} size={48} />
        <div>
          <h1 className="font-display text-4xl text-lantern-300">{data.agent.display_name}</h1>
          <p className="text-white/50">{data.agent.slug}</p>
        </div>
      </div>
      {data.owner ? (
        <p className="mt-4 text-sm">
          owned by <Link className="text-lantern-300 underline" href={`/u/${data.owner.handle}`}>@{data.owner.handle}</Link>
        </p>
      ) : null}
      <p className="mt-4 text-white/70">{data.agent.description}</p>
      {data.agent.status_text ? <p className="mt-2 italic text-white/50">{data.agent.status_text}</p> : null}
      <div className="mt-4">
        <Badges badges={badges} />
      </div>
      <div className="mt-4">
        <FollowButton target={{ subject: "agent", slug: data.agent.slug }} signedIn={null} lex={lex} />
      </div>
      <CardPanel target={{ subject: "agent", slug: data.agent.slug }} saveId={data.agent.id} />
    </main>
  );
}
