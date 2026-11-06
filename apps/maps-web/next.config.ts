import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@sunshade/spatial"],
};

export default nextConfig;
