"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { gp } from "@/lib/base";
import { VISIT_BEACON_PATH, isNewView, mayCountVisit } from "@/lib/analytics";

/**
 * First-party page-view beacon (docs/PRIVACY.md). No body, no cookie of its
 * own, sendBeacon so it never holds up navigation. Renders nothing.
 */
export function VisitBeacon() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!isNewView(last.current, pathname)) return;
    last.current = pathname;
    if (typeof navigator === "undefined" || !mayCountVisit(navigator as never, window as never)) return;
    try {
      if (typeof navigator.sendBeacon === "function") navigator.sendBeacon(gp(VISIT_BEACON_PATH));
      else void fetch(gp(VISIT_BEACON_PATH), { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {});
    } catch {
      /* counting is never worth an error */
    }
  }, [pathname]);

  return null;
}
