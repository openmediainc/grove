import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SearchPalette } from "@/components/SearchPalette";
import { VisitBeacon } from "@/components/VisitBeacon";
import { SpeedInsights } from "@vercel/speed-insights/next";

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
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        {children}
        <SearchPalette />
        <VisitBeacon />
        <SpeedInsights />
      </body>
    </html>
  );
}
