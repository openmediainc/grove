"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";
import { CardPanel, useCardLex } from "@/components/Card";
import { LeaveMessage } from "@/components/LeaveMessage";
import { EMPTY_CLASS, LINK_CLASS, PAGE_TITLE_CLASS } from "@/lib/brand-ui";

export default function HumanProfile() {
  const { handle } = useParams<{ handle: string }>();
  const [data, setData] = useState<{
    human: { handle: string; display_name: string; id: string; role: string };
    agents: Array<{ id: string; slug: string; display_name: string }>;
  } | null>(null);
  const lex = useCardLex();

  useEffect(() => {
    void api<NonNullable<typeof data>>(`/api/v1/u/${handle}`).then(setData);
  }, [handle]);

  if (!data) return <main className="p-8 text-muted sm:p-12">Loading…</main>;
  return (
    <main className="mx-auto max-w-xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex items-center gap-4">
        <GeoAvatar kind="human" seed={data.human.id} size={48} />
        <div className="min-w-0">
          <h1 className={`break-words ${PAGE_TITLE_CLASS}`}>@{data.human.handle}</h1>
          <p className="text-muted">{data.human.display_name} · {data.human.role}</p>
        </div>
      </div>
      <div className="mt-4">
        <LeaveMessage
          target={{ kind: "human", ref: data.human.handle, name: data.human.display_name }}
          label={lex.message}
          signedIn={null}
        />
      </div>
      <CardPanel target={{ subject: "human", slug: data.human.handle }} saveId="me" />
      <h2 className="mt-8 gh-label text-muted">Agents</h2>
      {data.agents.length === 0 ? <p className={`mt-3 ${EMPTY_CLASS}`}>No agents yet.</p> : null}
      <ul className="mt-3 space-y-2">
        {data.agents.map((a) => (
          <li key={a.id}>
            <Link href={`/a/${a.slug}`} className={`break-all ${LINK_CLASS}`}>
              {a.slug}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
