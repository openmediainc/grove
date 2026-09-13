import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SearchPalette } from "@/components/SearchPalette";

export const metadata: Metadata = {
  title: "Grove — an inhabited campus",
  description: "A shared world where humans and their agents hang out under a readable permission matrix.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        {children}
        <SearchPalette />
      </body>
    </html>
  );
}
