#!/usr/bin/env node
/**
 * Scaffold a new Conclave game end to end.
 *
 *   node packages/sfu/scripts/new-game.mjs <kebab-id> "Display Name"
 *
 * Creates:
 *   - packages/sfu/server/games/modules/<camel>.ts   (authoritative logic)
 *   - apps/web/src/app/components/games/<Pascal>Game.tsx  (renderer)
 * and registers both (server registry + web registry) automatically.
 *
 * After running: fill in the reducer in the module and the JSX in the renderer.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const [, , rawId, ...nameParts] = process.argv;
if (!rawId || !/^[a-z][a-z0-9-]*$/.test(rawId)) {
  console.error('Usage: node packages/sfu/scripts/new-game.mjs <kebab-id> "Display Name"');
  process.exit(1);
}
const id = rawId;
const name = nameParts.join(" ") || id;
const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const Pascal = camel.charAt(0).toUpperCase() + camel.slice(1);

const modulePath = resolve(repoRoot, `packages/sfu/server/games/modules/${camel}.ts`);
const rendererPath = resolve(repoRoot, `apps/web/src/app/components/games/${Pascal}Game.tsx`);
const serverRegistry = resolve(repoRoot, "packages/sfu/server/games/registry.ts");
const webRegistry = resolve(repoRoot, "apps/web/src/app/components/games/registry.tsx");

if (existsSync(modulePath) || existsSync(rendererPath)) {
  console.error(`Refusing to overwrite existing files for "${id}".`);
  process.exit(1);
}

const moduleTemplate = `import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";

type Phase = "lobby" | "active" | "results";

type ${Pascal}State = {
  phase: Phase;
  // TODO: model your authoritative state here.
};

export const ${camel}Module: GameModule<${Pascal}State> = {
  id: "${id}",
  name: "${name}",
  description: "TODO: one-line description shown in the launcher.",
  minPlayers: 1,
  maxPlayers: 24,
  tickMs: 500,

  setup(ctx: GameContext): ${Pascal}State {
    return { phase: "lobby" };
  },

  onMove(state, move: GameMove, ctx): ${Pascal}State {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        return { ...state, phase: "active" };
      }
      default:
        throw new GameMoveError(\`Unknown move: \${move.type}\`);
    }
  },

  onTick(state, ctx): ${Pascal}State {
    // TODO: drive deadlines / countdowns here, or delete onTick + tickMs.
    return state;
  },

  getPhase: (state) => state.phase,

  // Never leak secrets here - this goes to everyone.
  publicView(state, ctx) {
    return { phase: state.phase, serverNow: ctx.now, totalPlayers: ctx.players.length };
  },

  // This player's private slice (hidden information lives here).
  playerView(state, playerId, ctx) {
    return {};
  },

  isFinished: (state) => state.phase === "results",
};
`;

const rendererTemplate = `"use client";

import React from "react";
import { color } from "@conclave/ui-tokens";
import { HEAD_FONT, PrimaryButton, type GameViewProps } from "./gameUi";

type ${Pascal}Public = { phase: "lobby" | "active" | "results"; totalPlayers: number };
type ${Pascal}Me = Record<string, never>;

export default function ${Pascal}Game({
  pub,
  isAdmin,
  move,
}: GameViewProps<${Pascal}Public, ${Pascal}Me>) {
  if (pub.phase === "lobby") {
    return (
      <div style={{ textAlign: "center", padding: "12px 4px" }}>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, margin: "0 0 16px" }}>
          ${name}
        </p>
        {isAdmin ? (
          <PrimaryButton full onClick={() => move("start")}>Start</PrimaryButton>
        ) : (
          <p style={{ fontSize: 13, color: color.textFaint }}>Waiting for the host</p>
        )}
      </div>
    );
  }

  // TODO: render the active and results phases.
  return <p style={{ fontSize: 13, color: color.textMuted }}>TODO: build ${name}.</p>;
}
`;

writeFileSync(modulePath, moduleTemplate);
writeFileSync(rendererPath, rendererTemplate);

// Auto-register on the server: add import + array entry.
let server = readFileSync(serverRegistry, "utf8");
server = server.replace(
  /(import type \{ GameCatalogEntry)/,
  `import { ${camel}Module } from "./modules/${camel}.js";\n$1`,
);
server = server.replace(
  /(\n\];\n\nconst REGISTRY)/,
  `\n  ${camel}Module as GameModule,$1`,
);
writeFileSync(serverRegistry, server);

// Auto-register on the web: add import + map entry.
let web = readFileSync(webRegistry, "utf8");
web = web.replace(
  /(export const GAME_RENDERERS)/,
  `import ${Pascal}Game from "./${Pascal}Game";\n\n$1`,
);
web = web.replace(
  /(\n};\n\nexport const getGameRenderer)/,
  `\n  "${id}": ${Pascal}Game as React.ComponentType<GameViewProps>,$1`,
);
writeFileSync(webRegistry, web);

console.log(`Created game "${id}" (${name}).`);
console.log(`  server: packages/sfu/server/games/modules/${camel}.ts`);
console.log(`  web:    apps/web/src/app/components/games/${Pascal}Game.tsx`);
console.log("Both registries updated. Fill in the reducer + renderer, then run a typecheck.");
