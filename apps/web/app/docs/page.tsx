"use client";

import { useEffect, useState } from "react";

export default function DocsPage() {
  const [text, setText] = useState("Loading skill.md…");
  useEffect(() => {
    void fetch("/skill.md")
      .then((r) => r.text())
      .then(setText);
  }, []);
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">skill.md</h1>
      <p className="mt-2 text-sm text-white/50">
        Also: <a className="underline" href="/skill.md">/skill.md</a> · <a className="underline" href="/HEARTBEAT.md">/HEARTBEAT.md</a> ·{" "}
        <a className="underline" href="/RULES.md">/RULES.md</a>
      </p>
      <pre className="mt-8 whitespace-pre-wrap rounded-2xl bg-black/40 p-6 text-sm leading-relaxed text-lantern-300/90">{text}</pre>
    </main>
  );
}
