#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { normalizeConfig } from "../server/games/config.js";
import { GameSession } from "../server/games/engine.js";
import { bluffModule } from "../server/games/modules/bluff.js";
import { imposterModule } from "../server/games/modules/imposter.js";
import { mostLikelyToModule } from "../server/games/modules/mostLikelyTo.js";
import { triviaModule } from "../server/games/modules/trivia.js";
import { wouldYouRatherModule } from "../server/games/modules/wouldYouRather.js";
import type { GameConfig, GameModule, GamePlayer } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "player-1", name: "Mira" },
  { id: "player-2", name: "Sam" },
  { id: "player-3", name: "Dev" },
];

const cases: {
  module: GameModule;
  options: GameConfig;
  assertStarted: (view: unknown) => void;
}[] = [
  {
    module: triviaModule as GameModule,
    options: { topic: "space exploration", questions: 3, pace: "fast" },
    assertStarted(view) {
      assertView(view, "prompt");
      assertView(view, "options");
    },
  },
  {
    module: bluffModule as GameModule,
    options: { topic: "computer history", rounds: 2 },
    assertStarted(view) {
      assertView(view, "question");
    },
  },
  {
    module: wouldYouRatherModule as GameModule,
    options: { topic: "startup life", rounds: 3 },
    assertStarted(view) {
      assertView(view, "optionA");
      assertView(view, "optionB");
    },
  },
  {
    module: mostLikelyToModule as GameModule,
    options: { topic: "hackathon teams", rounds: 3 },
    assertStarted(view) {
      assertView(view, "prompt");
    },
  },
  {
    module: imposterModule as GameModule,
    options: { topic: "campus festivals", category: "surprise" },
    assertStarted(view) {
      assertView(view, "category");
    },
  },
];

for (const testCase of cases) {
  const config = normalizeConfig(testCase.module.options, testCase.options);
  const generateContent = testCase.module.generateContent;
  if (!generateContent) {
    throw new Error(`${testCase.module.id} does not have generateContent`);
  }
  const startedAt = Date.now();
  const content = await generateContent({
    players,
    config,
    now: startedAt,
  });
  assert.ok(content, `${testCase.module.id} did not generate content`);

  const session = new GameSession({
    module: testCase.module,
    players,
    adminIds: ["host"],
    hostId: "host",
    config,
    content,
    seed: 7,
  });
  const move = session.applyMove("host", "start", undefined);
  assert.deepEqual(move, { ok: true });
  testCase.assertStarted(session.getPublicState(Date.now()).view);

  console.log(`${testCase.module.id}: generated and started`);
}

function assertView(view: unknown, key: string): void {
  assert.ok(view && typeof view === "object" && !Array.isArray(view));
  assert.ok(key in view, `missing ${key}`);
  assert.notEqual((view as Record<string, unknown>)[key], null);
}
