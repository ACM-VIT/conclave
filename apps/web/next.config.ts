import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../..");
const yjsAlias = "./node_modules/yjs/dist/yjs.mjs";
const yProtocolsAlias = "./node_modules/y-protocols";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ["@conclave/apps-sdk", "@conclave/meeting-core"],
  turbopack: {
    root: workspaceRoot,
    resolveAlias: {
      yjs: yjsAlias,
      "yjs/dist/yjs.mjs": yjsAlias,
      "yjs/dist/yjs.cjs": yjsAlias,
      "y-protocols": yProtocolsAlias,
    },
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      yjs: path.resolve(workspaceRoot, yjsAlias),
      "yjs/dist/yjs.mjs": path.resolve(workspaceRoot, yjsAlias),
      "yjs/dist/yjs.cjs": path.resolve(workspaceRoot, yjsAlias),
      "y-protocols": path.resolve(workspaceRoot, yProtocolsAlias),
    };
    return config;
  },
};

export default nextConfig;
