#!/usr/bin/env node
/**
 * Codegen: SFU_EVENTS (packages/meeting-core/src/sfu-events.ts)
 *        → Swift enum (apps/conclave-skip/Sources/Conclave/Core/Networking/SfuEvents.swift)
 *
 * This makes the TypeScript registry the SINGLE SOURCE OF TRUTH for socket.io
 * event names across web and native. Re-run after editing sfu-events.ts:
 *
 *   node packages/meeting-core/scripts/gen-swift-events.mjs
 *
 * Keep this script plain Node-compatible for CI. It reads the TypeScript source
 * and evaluates only the SFU_EVENTS object literal, avoiding a TS loader.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const sourcePath = resolve(here, "../src/sfu-events.ts");

function findObjectLiteral(source, exportName) {
  const marker = `export const ${exportName}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find ${marker} in ${sourcePath}`);
  }
  const start = source.indexOf("{", markerIndex);
  if (start === -1) {
    throw new Error(`Could not find ${exportName} object literal`);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not parse ${exportName} object literal`);
}

const source = readFileSync(sourcePath, "utf8");
const objectLiteral = findObjectLiteral(source, "SFU_EVENTS");
const SFU_EVENTS = vm.runInNewContext(`(${objectLiteral})`, Object.create(null));

const OUT = resolve(
  repoRoot,
  "apps/conclave-skip/Sources/Conclave/Core/Networking/SfuEvents.swift",
);

/** Emit a Swift enum with String raw values from a {key: "wire"} group. */
function emitEnum(name, group, doc) {
  const lines = [];
  lines.push(`/// ${doc}`);
  lines.push(`enum ${name}: String {`);
  for (const [key, value] of Object.entries(group)) {
    // Quote the raw value only when it differs from the case name (it usually
    // does — wire strings are namespaced like "apps:open").
    lines.push(`    case ${key} = ${JSON.stringify(value)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

const header = `//
//  SfuEvents.swift
//  Conclave
//
//  GENERATED — do not edit by hand.
//  Source of truth: packages/meeting-core/src/sfu-events.ts
//  Regenerate:      node packages/meeting-core/scripts/gen-swift-events.mjs
//
//  These raw values are the exact socket.io event names the SFU server speaks,
//  identical to what the web client uses, so iOS/Android can never drift.
//
`;

const body = [
  emitEnum(
    "SfuSystemEvent",
    SFU_EVENTS.system,
    "Built-in socket.io lifecycle events.",
  ),
  emitEnum(
    "SfuClientEvent",
    SFU_EVENTS.clientToServer,
    "Client → server: requests, commands, and acknowledged RPCs.",
  ),
  emitEnum(
    "SfuServerEvent",
    SFU_EVENTS.serverToClient,
    "Server → client: notifications and broadcast state.",
  ),
].join("\n\n");
const generated = `${header}\n${body}\n`;

const counts = {
  system: Object.keys(SFU_EVENTS.system).length,
  clientToServer: Object.keys(SFU_EVENTS.clientToServer).length,
  serverToClient: Object.keys(SFU_EVENTS.serverToClient).length,
};
const countSummary = `system=${counts.system} clientToServer=${counts.clientToServer} serverToClient=${counts.serverToClient}`;

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== generated) {
    console.error(
      `Generated Swift events are out of date: ${OUT}\nRun this script without --check to update them.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Swift events are up to date (${countSummary}).`);
  }
} else {
  writeFileSync(OUT, generated);
  console.log(`Generated ${OUT}\n  ${countSummary}`);
}
