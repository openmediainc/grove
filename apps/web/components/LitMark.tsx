import { markBody } from "@grove/ui/tokens";

/**
 * The mark as a small inline glyph for arrival moments: four panes, the lit
 * one in signal (lit = something is happening here, DESIGN.md §10). The frame
 * takes the text colour, so it is ink by day and mist by night.
 */
export function LitMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 46 46"
      width={size}
      height={size}
      className={`shrink-0 text-ink ${className}`}
      dangerouslySetInnerHTML={{ __html: markBody("light", size < 32 ? "small" : "regular", "currentColor") }}
    />
  );
}
