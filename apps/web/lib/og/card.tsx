import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COLORS, PALETTE, WORDMARK_HEIGHT, WORDMARK_PATH, WORDMARK_WIDTH, markBody } from "@grove/ui/tokens";

/**
 * The Glasshouse OG template: 1200×630, Clear Pane day palette, mark +
 * wordmark, a mono eyebrow, one title and one terse line. Feed it PUBLIC data
 * only (a space's public name, an agent's public card) — never a private
 * space's name, members or activity (DECISIONS: privacy wins ties).
 */
export const OG_SIZE = { width: 1200, height: 630 } as const;

export type OgCardInput = {
  eyebrow: string;
  title: string;
  line?: string;
  mode?: "light" | "night";
  /** A space's branding accent: a stripe down the left edge, never text, never the lit pane. */
  accent?: string | null;
};

export async function ogFonts() {
  const dir = join(process.cwd(), "lib/og/fonts");
  const [display, mono] = await Promise.all([
    readFile(join(dir, "SchibstedGrotesk-ExtraBold.ttf")),
    readFile(join(dir, "FragmentMono-Regular.ttf")),
  ]);
  return [
    { name: "Schibsted Grotesk", data: display, weight: 800 as const, style: "normal" as const },
    { name: "Fragment Mono", data: mono, weight: 400 as const, style: "normal" as const },
  ];
}

function svgData(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Long names step the heading down so two lines still fit beside the pane grid. */
export function ogTitleSize(title: string): number {
  const n = Array.from(title).length;
  return n <= 44 ? 72 : 56;
}

export function OgCard({ eyebrow, title, line, mode = "light", accent = null }: OgCardInput) {
  const c = mode === "light" ? COLORS.light : COLORS.night;
  const ink = c.ink;
  const mark = svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" width="46" height="46">${markBody(mode === "light" ? "light" : "night")}</svg>`,
  );
  const wordmark = svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}"><path fill="${ink}" d="${WORDMARK_PATH}"/></svg>`,
  );
  // Mullion grid in the background: the pane motif, quiet.
  const grid = svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><g stroke="${c.line}" stroke-width="2" fill="none"><path d="M800 0v630M1000 0v630M800 210h400M800 420h400"/></g><rect x="1004" y="214" width="192" height="202" fill="${PALETTE.signal}" opacity="0.92"/></svg>`,
  );
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: c.ground,
        color: ink,
        fontFamily: "Schibsted Grotesk",
        position: "relative",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={grid} width={1200} height={630} alt="" style={{ position: "absolute", left: 0, top: 0 }} />
      {accent ? (
        <div style={{ position: "absolute", left: 0, top: 0, width: 20, height: 630, background: accent, borderRight: `2px solid ${c.line}` }} />
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={mark} width={64} height={64} alt="" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wordmark} width={Math.round((WORDMARK_WIDTH * 52) / WORDMARK_HEIGHT)} height={52} alt="" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 700 }}>
        <div style={{ fontFamily: "Fragment Mono", fontSize: 24, letterSpacing: 2, textTransform: "uppercase", color: c.muted }}>
          {eyebrow}
        </div>
        <div style={{ fontSize: ogTitleSize(title), fontWeight: 800, lineHeight: 1.04, letterSpacing: -2 }}>{title}</div>
        {line ? <div style={{ fontFamily: "Fragment Mono", fontSize: 28, color: c.muted }}>{line}</div> : null}
      </div>
    </div>
  );
}
