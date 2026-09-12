import type { NextConfig } from "next";

const api = process.env.GROVE_API_ORIGIN ?? "http://127.0.0.1:3511";

const nextConfig: NextConfig = {
  transpilePackages: ["@grove/protocol", "@grove/ui", "@grove/policy"],
  basePath: "/grove",
  skipTrailingSlashRedirect: true,
  allowedDevOrigins: ["q-ai.tail735569.ts.net", "127.0.0.1", "localhost"],
  async rewrites() {
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
