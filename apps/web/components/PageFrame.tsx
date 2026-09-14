"use client";

import { usePathname } from "next/navigation";
import { isBrandedRoute } from "@/lib/appearance";

/**
 * The page area under the nav. Pages already on the brand tokens render on the
 * viewer's mode; the rest (map chrome and page bodies, rollout #74–#75) sit in
 * a `[data-brand-legacy]` frame where the tokens stay at night, so their dark
 * classes stay readable when the chrome is in light mode.
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  const branded = isBrandedRoute(usePathname());
  return (
    <div data-brand-legacy={branded ? undefined : ""} className={`flex-1 bg-ground ${branded ? "" : "gh-legacy-page"}`}>
      {children}
    </div>
  );
}
