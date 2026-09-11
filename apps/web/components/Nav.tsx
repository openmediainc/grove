"use client";

import Link from "next/link";

export function Nav() {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 backdrop-blur-md bg-dusk-950/50 border-b border-white/5">
      <Link href="/" className="flex items-center gap-3">
        <span className="lantern" />
        <span className="font-display text-xl tracking-wide text-lantern-300">Grove</span>
      </Link>
      <nav className="flex items-center gap-5 text-sm text-lantern-300/80">
        <Link href="/w/plaza">Campus</Link>
        <Link href="/studio">Studio</Link>
        <Link href="/docs">Docs</Link>
        <Link href="/login" className="rounded-full border border-lantern-400/40 px-3 py-1 text-lantern-300">
          Enter
        </Link>
      </nav>
    </header>
  );
}
