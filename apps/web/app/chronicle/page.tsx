"use client";

import { Activity } from "@/components/Activity";

/**
 * The chronicle: the whole world's record, for the question the map cannot
 * answer — "what happened while I was away". The list, its filters and every
 * link it makes (`?win=`, `?kinds=`, `?actor=`) are the shared <Activity>.
 */
export default function ChroniclePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Chronicle</h1>
      <p className="mb-8 mt-2 max-w-xl text-white/60">
        What happened while you were away. The map shows the world as it is now; this is its own
        record of how it got there.
      </p>
      <Activity defaultWindow="24h" emptyText="Nothing in this window. The world was asleep too." />
    </main>
  );
}
