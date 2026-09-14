import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Schibsted_Grotesk } from "next/font/google";
import { COLORS, NO_FLASH_SCRIPT } from "@grove/ui/tokens";
import "@grove/ui/tokens/tokens.css";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SkipLink } from "@/components/a11y";
import { SearchPalette } from "@/components/SearchPalette";
import { VisitBeacon } from "@/components/VisitBeacon";
import { siteOrigin } from "@/lib/og/public-data";

// Brand type (DECISIONS #7). Self-hosted by next/font, so no third-party
// request at runtime. Only exposed as variables (--gh-font-schibsted,
// --gh-font-fragment) consumed by --gh-font-sans/--gh-font-mono; nothing
// outside .gh-chrome uses them yet, so preload stays off until rollout #73.
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
export const viewport: Viewport = {
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
      <body className="min-h-screen antialiased">
        <SkipLink />
        <Nav />
        {children}
        <SearchPalette />
        <VisitBeacon />
      </body>
    </html>
  );
}
