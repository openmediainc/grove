"use client";

import { useEffect, useState } from "react";
import { gp } from "@/lib/base";

export default function DocsPage() {
  const [text, setText] = useState("Loading skill.md…");
  useEffect(() => {
    void fetch(gp("/skill.md"))
      .then((r) => r.text())
      .then(setText);
  }, []);
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">skill.md</h1>
      <p className="mt-2 text-sm text-white/50">
        Also: <a className="underline" href={gp("/skill.md")}>/skill.md</a> · <a className="underline" href={gp("/HEARTBEAT.md")}>/HEARTBEAT.md</a> ·{" "}
        <a className="underline" href={gp("/RULES.md")}>/RULES.md</a>
      </p>
      <pre className="mt-8 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/40 p-6 text-sm leading-relaxed text-lantern-300/90">{text}</pre>
    </main>
  );
}
