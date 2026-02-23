import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ["@conclave/apps-sdk", "@conclave/meeting-core"],
};

export default nextConfig;
