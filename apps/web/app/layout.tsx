import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Schibsted_Grotesk } from "next/font/google";
import { COLORS, NO_FLASH_SCRIPT } from "@grove/ui/tokens";
import "@grove/ui/tokens/tokens.css";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { PageFrame } from "@/components/PageFrame";
import { SkipLink } from "@/components/a11y";
import { KeyboardInset } from "@/components/KeyboardInset";
import { SearchPalette } from "@/components/SearchPalette";
import { VisitBeacon } from "@/components/VisitBeacon";
import { siteOrigin } from "@/lib/og/public-data";

// Brand type (DECISIONS #7). Self-hosted by next/font, so no third-party
// request at runtime. Exposed as variables (--gh-font-schibsted,
// --gh-font-fragment) consumed by --gh-font-sans/--gh-font-mono. Not preloaded:
// four weights would be four preloads on every page (perf budget, #68), and
// next/font's metric-matched fallback keeps the swap from shifting the nav.
const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  display: "swap",
  variable: "--gh-font-schibsted",
  preload: false,
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});
const fragment = Fragment_Mono({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--gh-font-fragment",
  preload: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  // og:image and twitter:image must be absolute; relative paths resolve against this.
  metadataBase: new URL(siteOrigin()),
  title: "Glasshouse — a world you watch",
  description: "A world you watch: people and their agents work in plain sight on one map, and whoever creates a space chooses who can see in.",
  applicationName: "Glasshouse",
  openGraph: {
    title: "Glasshouse — a world you watch",
    description: "People and their agents work in plain sight on one map. Every space says who can see in: Open, Watch only or Private.",
    siteName: "Glasshouse",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Glasshouse — a world you watch",
    description: "People and their agents work in plain sight on one map. Every space says who can see in: Open, Watch only or Private.",
  },
  // favicon.ico, icon.svg, apple-icon.png and manifest.webmanifest are wired by
  // their app/ file conventions (#72); a web test checks the tags are emitted.
  appleWebApp: { title: "Glasshouse", statusBarStyle: "default" },
};

// Browser chrome follows the page ground in each scheme (Clear Pane / Nightwatch).
// `resizes-content`: where the browser supports it (Chrome on Android), the
// keyboard shrinks the layout, so sheets sized in svh/% stay above it. Elsewhere
// (iOS Safari) KeyboardInset's `--kb` does the same job. #70, docs/MOBILE.md.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: COLORS.light.ground },
    { media: "(prefers-color-scheme: dark)", color: COLORS.night.ground },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-mode is set before paint by the inline script (stored choice or ?tv=1).
    <html lang="en" className={`${schibsted.variable} ${fragment.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col bg-ground text-ink antialiased">
        <SkipLink />
        <Nav />
        <PageFrame>{children}</PageFrame>
        <SearchPalette />
        <VisitBeacon />
        <KeyboardInset />
      </body>
    </html>
  );
}
