#!/usr/bin/env node
// Builds the versioned, self-contained native embed pages (S60 13 c, d; C6-19) and copies them to the two native
// bundles. One HTML file per app (Whiteboard, and Spin the Wheel and Watch Together since ACT-8): the esbuild bundle of
// <app>/entry.tsx (React, Yjs and the SDK renderer inlined) and <app>/embed.css in the shared whiteboard/template.html,
// with a Content-Security-Policy that allows only those exact inline hashes and no network (connect-src 'none'). The
// one exception is Watch Together's frame-src: the privacy-enhanced YouTube player (WATCH_FRAME_ORIGIN in protocol.ts)
// and nothing else; no YouTube script runs in the page. Never deployed anywhere: the files ship inside the app.
//
//   pnpm -C packages/apps-sdk run build:native-embed           # build and write the native copies
//   pnpm -C packages/apps-sdk run build:native-embed -- --check  # fail when a native copy is missing or stale
//
// Outputs, for <app> in whiteboard, wheel and watch:
//   apps/conclave-skip/Sources/Conclave/Resources/native-embed-<app>.html   (iOS, Bundle.module, served at
//     conclave-embed://app/<app>.html by NativeEmbedSchemeHandler)
//   apps/conclave-skip/Android/app/src/main/assets/native-embed/<app>.html  (Android, WebViewAssetLoader at
//     https://appassets.androidplatform.net/assets/native-embed/<app>.html)
// esbuild comes from the hoisted workspace tree (pnpm nodeLinker hoisted).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const embedDir = path.resolve(buildDir, "..");
const repoDir = path.resolve(embedDir, "..", "..", "..", "..");
const check = process.argv.includes("--check");

const protocolSource = readFileSync(path.join(embedDir, "protocol.ts"), "utf8");
const constant = (name) => {
  const match = protocolSource.match(new RegExp(`export const ${name} = "?([^";\\n]+)"?;`));
  if (!match) throw new Error(`protocol.ts has no ${name}`);
  return match[1];
};
const bundleVersion = constant("NATIVE_EMBED_BUNDLE_VERSION");
const protocolVersion = constant("NATIVE_EMBED_PROTOCOL_VERSION");
const watchFrameOrigin = constant("WATCH_FRAME_ORIGIN");
if (!/^https:\/\/[a-z0-9.-]+$/.test(watchFrameOrigin)) throw new Error("WATCH_FRAME_ORIGIN must be one https origin");

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error("build-native-embed: esbuild is not installed in the workspace (expected in the hoisted node_modules).");
  process.exit(1);
}

const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const template = path.join(embedDir, "whiteboard", "template.html");
const appEntry = (appId, frameSource) => ({
  appId,
  entry: path.join(embedDir, appId, "entry.tsx"),
  css: path.join(embedDir, appId, "embed.css"),
  template,
  frameSource,
  outputs: [
    path.join(repoDir, "apps", "conclave-skip", "Sources", "Conclave", "Resources", `native-embed-${appId}.html`),
    path.join(repoDir, "apps", "conclave-skip", "Android", "app", "src", "main", "assets", "native-embed", `${appId}.html`),
  ],
});

const apps = [appEntry("whiteboard", "'none'"), appEntry("wheel", "'none'"), appEntry("watch", watchFrameOrigin)];

let failed = false;
for (const app of apps) {
  const result = await esbuild.build({
    entryPoints: [app.entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["safari15", "chrome100"],
    minify: true,
    legalComments: "none",
    jsx: "automatic",
    charset: "utf8",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  // An inline script must never contain its own end tag.
  const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const style = (await esbuild.transform(readFileSync(app.css, "utf8"), {
    loader: "css",
    legalComments: "inline",
    minifyWhitespace: true,
  })).code;
  if (/gradient/i.test(style)) throw new Error(`${app.appId}: the embed CSS must stay flat (no gradients)`);
  const csp = [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    "img-src data: blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    `frame-src ${app.frameSource}`,
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const html = readFileSync(app.template, "utf8")
    .replace("%CSP%", () => csp)
    .replace("%APP%", () => app.appId)
    .replace("%VERSION%", () => bundleVersion)
    .replace("%PROTOCOL%", () => protocolVersion)
    .replace("%STYLE%", () => style)
    .replace("%SCRIPT%", () => script);
  for (const output of app.outputs) {
    if (check) {
      if (!existsSync(output) || readFileSync(output, "utf8") !== html) {
        console.error(`build-native-embed: ${path.relative(repoDir, output)} is missing or stale; run build:native-embed`);
        failed = true;
      }
      continue;
    }
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, html);
    console.log(`build-native-embed: wrote ${path.relative(repoDir, output)} (${app.appId} ${bundleVersion}, ${html.length} bytes)`);
  }
}
if (failed) process.exit(1);
