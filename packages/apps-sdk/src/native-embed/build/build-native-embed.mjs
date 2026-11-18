#!/usr/bin/env node

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
