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
 * Node 22+ strips the TS types on import, so we can import the .ts directly and
 * read the runtime object. No build step required.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const { SFU_EVENTS } = await import(resolve(here, "../src/sfu-events.ts"));

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

writeFileSync(OUT, `${header}\n${body}\n`);

const counts = {
  system: Object.keys(SFU_EVENTS.system).length,
  clientToServer: Object.keys(SFU_EVENTS.clientToServer).length,
  serverToClient: Object.keys(SFU_EVENTS.serverToClient).length,
};
console.log(
  `Generated ${OUT}\n  system=${counts.system} clientToServer=${counts.clientToServer} serverToClient=${counts.serverToClient}`,
);
