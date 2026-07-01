import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../..");
const readGitSha = (): string | null => {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const conclaveClientVersion =
  process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  readGitSha() ||
  "local";
const yjsTurbopackAlias = "./node_modules/yjs/dist/yjs.mjs";
const yProtocolsTurbopackAlias = "./node_modules/y-protocols";
const yjsWebpackAlias = path.resolve(
  workspaceRoot,
  "node_modules/yjs/dist/yjs.mjs",
);
const yProtocolsWebpackAlias = path.resolve(
  workspaceRoot,
  "node_modules/y-protocols",
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  deploymentId:
    conclaveClientVersion === "local" ? undefined : conclaveClientVersion,
  env: {
    NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION: conclaveClientVersion,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: [
    "@conclave/apps-sdk",
    "@conclave/meeting-core",
    "@conclave/ui-tokens",
  ],
  turbopack: {
    root: workspaceRoot,
    resolveAlias: {
      yjs: yjsTurbopackAlias,
      "yjs/dist/yjs.mjs": yjsTurbopackAlias,
      "yjs/dist/yjs.cjs": yjsTurbopackAlias,
      "y-protocols": yProtocolsTurbopackAlias,
    },
  },
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  async redirects() {
    return [
      {
        source: "/favicon.ico",
        destination: "/favicon.svg",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/transcript-pcm-processor.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
        ],
      },
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
      yjs: yjsWebpackAlias,
      "yjs/dist/yjs.mjs": yjsWebpackAlias,
      "yjs/dist/yjs.cjs": yjsWebpackAlias,
      "y-protocols": yProtocolsWebpackAlias,
    };
    return config;
  },
};

export default nextConfig;
