#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionAnswer } from "@conclave/ai/decisions";
import { normalizeConfig } from "../server/games/config.js";
import { GameSession } from "../server/games/engine.js";
import { LONG_SHOT_BANK, type LongShotListTier } from "../server/games/longShotBank.js";
import { longShotModule } from "../server/games/modules/longShot.js";
import { getGameCatalog } from "../server/games/registry.js";
import type { GameConfig, GameDecider, GamePlayer } from "../server/games/types.js";

const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/conclave-skip/Tests/ConclaveTests/Resources/LongShotFixtures.json",
);

const host: GamePlayer = { id: "host", name: "Avery" };
const sam: GamePlayer = { id: "p2", name: "Sam" };
const robin: GamePlayer = { id: "p3", name: "Robin" };
const watcher: GamePlayer = { id: "watch", name: "Jules" };
const late: GamePlayer = { id: "late", name: "Kai" };
const seated = [host, sam, robin];

let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
Date.now = () => clock;

const RARITY: Record<LongShotListTier, number> = { obvious: 0, cliche: 1, solid: 2, rare: 3, longShot: 4 };
const accepted = new Map<string, LongShotListTier>();

const decide: GameDecider = async ({ state, questions }) => {
  const guess = String((state as { guess?: unknown }).guess ?? "");
  const tier = accepted.get(guess);
  const level = tier ? RARITY[tier] : 0;
  const answers: Record<string, DecisionAnswer> = {
    unsafe: { type: "noul", noul: 0.02 },
    correct: { type: "noul", noul: tier ? 0.91 : 0.12 },
    rarity: { type: "score", score: level, probabilities: { [String(level)]: 0.82 }, confidence: 0.8 },
  };
  if (questions.listed) answers.listed = { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 };
  if (questions.repeat) answers.repeat = { type: "choice", choice: "new", probabilities: { new: 0.9 }, confidence: 0.9 };
  return answers;
};

type Snapshot = { public: unknown; views: Record<string, unknown> };
const snapshots: Record<string, Snapshot> = {};

const snap = (name: string, session: GameSession, viewers: GamePlayer[]) => {
  if (snapshots[name]) throw new Error(`duplicate snapshot ${name}`);
  const views: Record<string, unknown> = {};
  for (const viewer of viewers) views[viewer.id] = session.getPlayerView(viewer.id, clock);
  snapshots[name] = JSON.parse(JSON.stringify({ public: session.getPublicState(clock), views })) as Snapshot;
};

const move = async (session: GameSession, player: GamePlayer, type: string, payload: unknown = {}) => {
  const receivedAt = Date.now();
  const prepared = await session.prepareMove(player.id, type, payload, {
    decide,
    signal: new AbortController().signal,
    receivedAt,
  });
  if (!prepared.ok) throw new Error(`${type} by ${player.id} not prepared: ${prepared.error}`);
  const result = session.applyMove(player.id, type, payload, { verified: prepared.verified, receivedAt });
  if (!result.ok) throw new Error(`${type} by ${player.id} rejected: ${result.error}`);
};

const answer = (session: GameSession, player: GamePlayer, text: string) => move(session, player, "answer", { text });

const advance = (session: GameSession, ms: number) => {
  clock += ms;
  session.tick(clock);
};

const view = (session: GameSession) => session.getPublicState(clock).view as {
  phase: string;
  prompt: string | null;
  turnPlayerId: string | null;
  deadline: number | null;
};

const promptOf = (session: GameSession) => {
  const text = view(session).prompt;
  const prompt = LONG_SHOT_BANK.find((entry) => entry.prompt === text);
  if (!prompt) throw new Error(`prompt not in bank: ${text}`);
  return prompt;
};

const firstName = (entry: string) => entry.split("|")[0].trim();

const OFF_LIST: Record<string, string> = {
  "Name a programming language": "Modula-2",
  "Name a board game": "Tigris and Euphrates",
};

const offList = (prompt: { prompt: string }, tier: LongShotListTier) => {
  const text = OFF_LIST[prompt.prompt];
  if (!text) throw new Error(`no off-list answer for ${prompt.prompt}; add one to OFF_LIST`);
  accepted.set(text, tier);
  return text;
};

const expectPhase = (session: GameSession, phase: string) => {
  const actual = view(session).phase;
  if (actual !== phase) throw new Error(`expected phase ${phase}, saw ${actual}`);
};

const startSession = (config: GameConfig, seed: number) =>
  new GameSession({
    module: longShotModule,
    players: seated,
    adminIds: [host.id],
    hostId: host.id,
    config: normalizeConfig(longShotModule.options, config),
    seed,
  });

const everyone = [...seated, watcher];

const captureClassic = async () => {
  const session = startSession({ topic: "", mode: "classic", prompts: 3, pace: "normal" }, 7);
  session.updateRoomMembership({ players: [...seated, watcher, late], adminIds: [host.id] });
  snap("classic-lobby", session, everyone);

  await move(session, host, "start");
  expectPhase(session, "ready");
  snap("classic-ready", session, everyone);

  advance(session, 3_000);
  expectPhase(session, "prompt");
  const first = promptOf(session);
  const judgedRare = offList(first, "rare");
  snap("classic-prompt-open", session, everyone);

  clock += 1_400;
  await answer(session, sam, "Zzyzx");
  clock += 900;
  await answer(session, host, firstName(first.obvious[0]));
  const seat = session.requestSeat(late);
  if (!seat.ok) throw new Error(`late seat refused: ${seat.error}`);
  snap("classic-prompt-miss", session, [...everyone, late]);

  clock += 1_100;
  await answer(session, robin, judgedRare);
  clock += 700;
  await answer(session, sam, firstName(first.pearl));
  advance(session, 0);
  expectPhase(session, "reveal");
  snap("classic-reveal", session, [...everyone, late]);

  await move(session, host, "next");
  advance(session, 0);
  expectPhase(session, "ready");
  snap("classic-ready-seated", session, [...everyone, late]);

  advance(session, 3_000);
  const second = promptOf(session);
  clock += 2_000;
  await answer(session, sam, "Zzyzx");
  await answer(session, host, firstName(second.rare[0]));
  await answer(session, robin, firstName(second.longShot[0]));
  await answer(session, late, firstName(second.cliche[0]));
  await move(session, host, "skip");
  advance(session, 0);
  expectPhase(session, "reveal");
  snap("classic-reveal-no-answer", session, [...everyone, late]);

  await move(session, host, "next");
  advance(session, 0);
  advance(session, 3_000);
  const third = promptOf(session);
  await answer(session, host, firstName(third.solid[0]));
  await answer(session, sam, firstName(third.longShot[1]));
  await answer(session, robin, firstName(third.obvious[1]));
  await answer(session, late, firstName(third.rare[1]));
  advance(session, 0);
  expectPhase(session, "reveal");
  advance(session, 9_000);
  expectPhase(session, "results");
  snap("classic-results", session, [...everyone, late]);
};

const captureFuse = async () => {
  const session = startSession({ topic: "", mode: "fuse", lives: 2, pace: "fast" }, 11);
  session.updateRoomMembership({ players: [...seated, watcher], adminIds: [host.id] });
  snap("fuse-lobby", session, everyone);

  await move(session, host, "start");
  expectPhase(session, "fuse");
  snap("fuse-turn", session, everyone);

  const byId = new Map(seated.map((player) => [player.id, player]));
  const holder = () => {
    const id = view(session).turnPlayerId;
    const player = id ? byId.get(id) : undefined;
    if (!player) throw new Error(`no holder: ${id}`);
    return player;
  };

  const prompt = promptOf(session);
  const opener = firstName(prompt.solid[0]);
  clock += 1_200;
  await answer(session, holder(), opener);
  clock += 1_000;
  await answer(session, holder(), opener);
  snap("fuse-miss-used", session, everyone);

  const judged = offList(prompt, "longShot");
  clock += 900;
  await answer(session, holder(), judged);
  snap("fuse-chain-judged", session, everyone);

  const banker = holder();
  const deep = [...prompt.longShot.map(firstName), firstName(prompt.pearl), ...prompt.rare.map(firstName)];
  const unused = deep.filter((name) => name !== judged);
  let guard = 0;
  while (!(session.getPublicState(clock).view as { lastHeart: unknown }).lastHeart) {
    if (guard++ > 60 || unused.length === 0) throw new Error("no heart earned");
    const current = holder();
    clock += 600;
    await answer(session, current, current.id === banker.id ? unused.shift()! : unused.pop()!);
  }
  snap("fuse-heart", session, everyone);

  session.updateRoomMembership({ players: [host, watcher], adminIds: [host.id] });
  advance(session, 250);
  snap("fuse-paused", session, everyone);
  session.updateRoomMembership({ players: [...seated, watcher], adminIds: [host.id] });
  advance(session, 250);

  const burn = () => {
    let ticks = 0;
    while (view(session).phase === "fuse") {
      if (ticks++ > 400) throw new Error("fuse never popped");
      advance(session, longShotModule.tickMs ?? 250);
    }
  };
  burn();
  expectPhase(session, "popped");
  snap("fuse-popped", session, everyone);

  advance(session, 2_800);
  expectPhase(session, "fuse");
  let rounds = 0;
  while (view(session).phase !== "results") {
    if (rounds++ > 20) throw new Error("fuse never finished");
    burn();
    const popped = (session.getPublicState(clock).view as { popped: { eliminated: boolean } | null }).popped;
    if (view(session).phase === "popped" && popped?.eliminated && !snapshots["fuse-popped-out"]) {
      snap("fuse-popped-out", session, everyone);
    }
    if (view(session).phase === "popped") advance(session, 2_800);
  }
  snap("fuse-results", session, everyone);
};

await captureClassic();
await captureFuse();

const catalog = getGameCatalog().find((entry) => entry.id === longShotModule.id);
const fixture = `${JSON.stringify(
  {
    generatedBy: "packages/sfu/scripts/capture-long-shot-fixtures.ts",
    players: { host, sam, robin, watcher, late },
    catalog,
    snapshots,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUTPUT, "utf8");
  if (current !== fixture) {
    console.error(`${path.relative(process.cwd(), OUTPUT)} is stale; rerun without --check`);
    process.exit(1);
  }
  console.log(`fixtures match the engine (${Object.keys(snapshots).length} snapshots)`);
} else {
  writeFileSync(OUTPUT, fixture);
  console.log(`wrote ${Object.keys(snapshots).length} snapshots to ${path.relative(process.cwd(), OUTPUT)}`);
}
