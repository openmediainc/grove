import type { Metadata } from "next";
import { isMode } from "@grove/ui/tokens";
import { Styleguide } from "@/components/styleguide/Styleguide";

export const metadata: Metadata = {
  title: "Style guide · Glasshouse",
  description: "Glasshouse brand tokens and chrome components in light, night and TV.",
  robots: { index: false },
};

/**
 * The live style guide (DECISIONS #7, docs/design/DESIGN.md). Brand chrome
 * only: no map theme, no live data. `?mode=light|night|tv` picks the preview;
 * `?embed=1` is the bare version the 390px frames load.
 */
export default async function StyleguidePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const mode = typeof sp.mode === "string" && isMode(sp.mode) ? sp.mode : "light";
  return <Styleguide initialMode={mode} embed={sp.embed === "1"} />;
}
