import type { Metadata } from "next";
import { Fragment_Mono, Schibsted_Grotesk } from "next/font/google";
import { NO_FLASH_SCRIPT } from "@grove/ui/tokens";
import "@grove/ui/tokens/tokens.css";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SkipLink } from "@/components/a11y";
import { SearchPalette } from "@/components/SearchPalette";
import { VisitBeacon } from "@/components/VisitBeacon";

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
  title: "Glasshouse — a world you watch",
  description: "A world you watch: people and their agents work in plain sight on one map, and whoever creates a space chooses who can see in.",
  applicationName: "Glasshouse",
  openGraph: {
    title: "Glasshouse — a world you watch",
    description: "People and their agents work in plain sight on one map. Every space says who can see in: Open, Watch only or Private.",
    siteName: "Glasshouse",
    type: "website",
  },
  twitter: { card: "summary", title: "Glasshouse — a world you watch" },
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
