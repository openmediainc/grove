import type { NextConfig } from "next";
import { legacyRedirects } from "./lib/agent-page";
import { spaceRedirects } from "./lib/space-page";
import { worldRedirects } from "./lib/world-url";

const api = process.env.VERCEL ? null : (process.env.GROVE_API_ORIGIN ?? "http://127.0.0.1:3511");
const base = process.env.NEXT_PUBLIC_GROVE_BASE;
const basePath = base && base !== "/" ? base : process.env.VERCEL ? undefined : "/grove";

const nextConfig: NextConfig = {
  transpilePackages: ["@grove/protocol", "@grove/ui", "@grove/policy"],
  // The workspace packages ship TypeScript source and spell their internal
  // imports with a `.js` suffix, because Node's ESM loader requires it. tsc
  // rewrites that silently; webpack does not, and looks for a literal `.js`
  // that never existed — which fails at runtime while `pnpm typecheck` stays
  // green. Teach the bundler the same rule so shared code is importable here.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  ...(basePath ? { basePath } : {}),
  // `lib/base.ts` falls back on `process.env.VERCEL`, but Next only inlines
  // NEXT_PUBLIC_* into client bundles — in the browser VERCEL is undefined, so
  // every client fetch and canvas image went to `/grove/...` and 404'd on
  // Vercel. Inline the resolved base so server and client always agree.
  env: { NEXT_PUBLIC_GROVE_BASE: basePath ?? "" },
  skipTrailingSlashRedirect: true,
  allowedDevOrigins: ["q-ai.tail735569.ts.net", "127.0.0.1", "localhost"],
  // Old agent routes land on the agent page or /me, old space routes on Explore
  // or the space page (DECISIONS #5: never a 404).
  async redirects() {
    return [
      ...legacyRedirects({ publicDeploy: Boolean(process.env.VERCEL) }),
      ...spaceRedirects(),
      // Rooms and the History are drawers on the map; the walk-in is a sheet there.
      ...worldRedirects(),
    ];
  },
  async rewrites() {
    if (!api) return [];
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/mcp", destination: `${api}/mcp` },
      { source: "/mcp/:path*", destination: `${api}/mcp/:path*` },
      { source: "/skill.md", destination: `${api}/skill.md` },
      { source: "/HEARTBEAT.md", destination: `${api}/HEARTBEAT.md` },
      { source: "/RULES.md", destination: `${api}/RULES.md` },
      { source: "/skill.json", destination: `${api}/skill.json` },
      { source: "/health", destination: `${api}/health` },
      { source: "/ready", destination: `${api}/ready` },
      { source: "/peer/:path*", destination: `${api}/peer/:path*` },
      { source: "/awn/:path*", destination: `${api}/awn/:path*` },
      { source: "/world/agents", destination: `${api}/world/agents` },
    ];
  },
};

export default nextConfig;
