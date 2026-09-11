import type { NextConfig } from "next";

const api = process.env.GROVE_API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  transpilePackages: ["@grove/protocol", "@grove/ui", "@grove/policy"],
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
    ];
  },
};

export default nextConfig;
