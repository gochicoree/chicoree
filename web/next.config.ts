import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Do not write editor/agent rule files into the checkout on every dev run.
  agentRules: false,
  // The registry streams big payloads; the web app never should. Keep server
  // actions small and predictable.
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
};

export default nextConfig;
