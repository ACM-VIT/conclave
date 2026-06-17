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
  images: {
    unoptimized: true,
  },
  transpilePackages: ["@conclave/apps-sdk", "@conclave/meeting-core", "@conclave/ui-tokens"],
  turbopack: {
    root: workspaceRoot,
    resolveAlias: {
      yjs: yjsAlias,
      "yjs/dist/yjs.mjs": yjsAlias,
      "yjs/dist/yjs.cjs": yjsAlias,
      "y-protocols": yProtocolsAlias,
    },
  },
  async headers() {
    return [
      {
        source: "/mediapipe/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
      {
        source: "/effects/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
      {
        source: "/_/rtcvidproc/release/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      fallback: [
        {
          source: "/_/rtcvidproc/release/assets/:path*",
          destination: "https://www.gstatic.com/video_effects/assets/:path*",
        },
        {
          source: "/_/rtcvidproc/release/:release/:path*",
          destination:
            "https://www.gstatic.com/video_effects/effects/:release/brotli/:path*",
        },
      ],
    };
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
