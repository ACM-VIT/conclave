import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { payloadField, requireString } from "../validation.js";
import { numberOption, selectOption } from "../config.js";
import { allActivePlayersActed } from "../roundLoop.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedStringArray,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";
import {
  LONG_SHOT_BANK,
  LONG_SHOT_TIER_POINTS,
  LONG_SHOT_TIERS,
  compilePrompt,
  matchAnswer,
  type CompiledAnswer,
  type CompiledPrompt,
  type LongShotPrompt,
  type LongShotTier,
} from "../longShotBank.js";

type Mode = "classic" | "fuse";
type Phase = "lobby" | "prompt" | "reveal" | "fuse" | "popped" | "results";

const CLASSIC_PACE_MS: Record<string, number> = { relaxed: 40_000, normal: 25_000, fast: 15_000 };
const FUSE_PACE_MS: Record<string, number> = { relaxed: 15_000, normal: 10_000, fast: 7_000 };
const REVEAL_MS = 9_000;
const POPPED_MS = 4_000;
const MIN_FUSE_MS = 4_000;
const FUSE_SHRINK_MS = 250;
const MAX_TRIES = 3;
const MAX_ANSWER_LENGTH = 48;
const ONLY_YOU_BONUS = 200;
const SURVIVOR_BONUS = 2000;
const CHAIN_LENGTH = 10;
const DEFAULT_PROMPTS = 7;
const DEFAULT_LIVES = 2;
const FUSE_GENERATED_PROMPTS = 8;

type Miss = { text: string; reason: "unknown" | "used"; at: number };

type ClassicEntry = {
  answer: CompiledAnswer | null;
  misses: number;
  lastMiss: Miss | null;
  at: number;
};

type RoundResult = {
  playerId: string;
  answer: string | null;
  tier: LongShotTier | null;
  points: number;
  bonus: number;
  shared: boolean;
};

type ChainLink = {
  playerId: string;
  answer: string;
  tier: LongShotTier;
  points: number;
};

type BestAnswer = { answer: string; tier: LongShotTier; prompt: string; points: number };

type LongShotState = {
  mode: Mode;
  phase: Phase;
  prompts: CompiledPrompt[];
  promptIndex: number;
  totalPrompts: number;
  deadline: number;
  scores: Record<string, number>;
  best: Record<string, BestAnswer>;
  promptMs: number;
  entries: Record<string, ClassicEntry>;
  results: RoundResult[];
  missedGems: string[];
  obviousPicks: string[];
  fuseMs: number;
  currentFuseMs: number;
  maxLives: number;
  order: string[];
  turnPlayerId: string | null;
  lives: Record<string, number>;
  used: string[];
  chain: ChainLink[];
  lastMiss: (Miss & { playerId: string }) | null;
  popped: { playerId: string; eliminated: boolean } | null;
  outOrder: string[];
  winnerId: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const TIER_LIMITS: Record<LongShotTier, { min: number; max: number }> = {
  obvious: { min: 3, max: 12 },
  solid: { min: 4, max: 20 },
  rare: { min: 4, max: 25 },
  longShot: { min: 4, max: 30 },
};

const MIN_ANSWERS_PER_PROMPT = 18;

const parseGeneratedPrompts = (payload: unknown, minItems = 1): LongShotPrompt[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prompts)) return null;
  const out: LongShotPrompt[] = [];
  const seenPrompts = new Set<string>();
  for (const item of payload.prompts) {
    if (!isRecord(item)) continue;
    const prompt = cleanGeneratedText(item.prompt, 100);
    const category = cleanGeneratedText(item.category, 32) ?? "Custom";
    if (!prompt) continue;
    const promptKey = normalizeGeneratedKey(prompt);
    if (!promptKey || seenPrompts.has(promptKey)) continue;
    const tiers = {} as Record<LongShotTier, string[]>;
    let valid = true;
    for (const tier of LONG_SHOT_TIERS) {
      const list = cleanGeneratedStringArray(item[tier], {
        maxItems: TIER_LIMITS[tier].max,
        maxLength: 80,
      });
      if (list.length < TIER_LIMITS[tier].min) valid = false;
      tiers[tier] = list;
    }
    if (!valid) continue;
    const raw: LongShotPrompt = { category, prompt, ...tiers };
    if (compilePrompt(raw).answers.length < MIN_ANSWERS_PER_PROMPT) continue;
    seenPrompts.add(promptKey);
    out.push(raw);
    if (out.length >= 15) break;
  }
  return out.length >= minItems ? out : null;
};

const tierSchema = (tier: LongShotTier) => ({
  type: "array",
  minItems: TIER_LIMITS[tier].min,
  maxItems: TIER_LIMITS[tier].max,
  items: { type: "string", maxLength: 80 },
});

const playerName = (ctx: GameContext, playerId: string): string =>
  ctx.players.find((player) => player.id === playerId)?.name ?? "Player";

const currentPrompt = (state: LongShotState): CompiledPrompt | undefined =>
  state.prompts.length > 0
    ? state.prompts[state.promptIndex % state.prompts.length]
    : undefined;

const tierCounts = (prompt: CompiledPrompt | undefined): Record<LongShotTier, number> => {
  const counts: Record<LongShotTier, number> = { obvious: 0, solid: 0, rare: 0, longShot: 0 };
  for (const answer of prompt?.answers ?? []) counts[answer.tier] += 1;
  return counts;
};

const recordBest = (
  best: Record<string, BestAnswer>,
  playerId: string,
  answer: CompiledAnswer,
  prompt: CompiledPrompt,
  points: number,
): Record<string, BestAnswer> => {
  const previous = best[playerId];
  if (previous && previous.points >= points) return best;
  return {
    ...best,
    [playerId]: { answer: answer.display, tier: answer.tier, prompt: prompt.prompt, points },
  };
};

const scoreboard = (state: LongShotState, ctx: GameContext) =>
  ctx.players
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: state.scores[player.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score);

const isActive = (ctx: GameContext, playerId: string): boolean =>
  ctx.activePlayers.some((player) => player.id === playerId);

const alivePlayers = (state: LongShotState): string[] =>
  state.order.filter((playerId) => (state.lives[playerId] ?? 0) > 0);

const nextAlive = (state: LongShotState, fromId: string | null): string | null => {
  const alive = new Set(alivePlayers(state));
  if (alive.size === 0) return null;
  const start = fromId ? state.order.indexOf(fromId) : -1;
  for (let step = 1; step <= state.order.length; step++) {
    const candidate = state.order[(start + step + state.order.length) % state.order.length];
    if (alive.has(candidate)) return candidate;
  }
  return null;
};

const nextAliveConnected = (
  state: LongShotState,
  fromId: string | null,
  ctx: GameContext,
): string | null => {
  let cursor = fromId;
  for (let step = 0; step < state.order.length; step++) {
    const candidate = nextAlive(state, cursor);
    if (!candidate) return null;
    if (isActive(ctx, candidate)) return candidate;
    cursor = candidate;
  }
  return nextAlive(state, fromId);
};

const fuseIsOver = (state: LongShotState): boolean => {
  const alive = alivePlayers(state).length;
  return state.order.length > 1 ? alive <= 1 : alive === 0;
};

const enterPrompt = (state: LongShotState, index: number, ctx: GameContext): LongShotState => ({
  ...state,
  phase: "prompt",
  promptIndex: index,
  deadline: ctx.now + state.promptMs,
  entries: {},
  results: [],
  missedGems: [],
  obviousPicks: [],
});

const classicLocked = (entry: ClassicEntry | undefined): boolean =>
  Boolean(entry && (entry.answer || entry.misses >= MAX_TRIES));

const scoreClassicRound = (state: LongShotState, ctx: GameContext): LongShotState => {
  const prompt = currentPrompt(state);
  if (!prompt) return { ...state, phase: "reveal", deadline: ctx.now + REVEAL_MS };
  const counts = new Map<string, number>();
  for (const entry of Object.values(state.entries)) {
    if (entry.answer) counts.set(entry.answer.id, (counts.get(entry.answer.id) ?? 0) + 1);
  }
  const validAnswerers = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const scores = { ...state.scores };
  let best = state.best;
  const results: RoundResult[] = [];
  for (const [playerId, entry] of Object.entries(state.entries)) {
    if (!entry.answer) {
      results.push({ playerId, answer: null, tier: null, points: 0, bonus: 0, shared: false });
      continue;
    }
    const shared = (counts.get(entry.answer.id) ?? 0) > 1;
    const base = LONG_SHOT_TIER_POINTS[entry.answer.tier];
    const bonus = !shared && validAnswerers > 1 ? ONLY_YOU_BONUS : 0;
    const points = base + bonus;
    scores[playerId] = (scores[playerId] ?? 0) + points;
    best = recordBest(best, playerId, entry.answer, prompt, base);
    results.push({
      playerId,
      answer: entry.answer.display,
      tier: entry.answer.tier,
      points,
      bonus,
      shared,
    });
  }
  results.sort((a, b) => b.points - a.points || (a.answer ?? "").localeCompare(b.answer ?? ""));
  const said = new Set(
    Object.values(state.entries)
      .map((entry) => entry.answer?.id)
      .filter((id): id is string => Boolean(id)),
  );
  const missedGems = ctx.rng
    .shuffle(prompt.answers.filter((a) => a.tier === "longShot" && !said.has(a.id)))
    .slice(0, 5)
    .map((a) => a.display);
  const obviousPicks = prompt.answers
    .filter((a) => a.tier === "obvious")
    .slice(0, 4)
    .map((a) => a.display);
  return {
    ...state,
    phase: "reveal",
    deadline: ctx.now + REVEAL_MS,
    scores,
    best,
    results,
    missedGems,
    obviousPicks,
  };
};

const enterFuse = (
  state: LongShotState,
  promptIndex: number,
  turnPlayerId: string | null,
  ctx: GameContext,
): LongShotState => ({
  ...state,
  phase: "fuse",
  promptIndex,
  turnPlayerId,
  currentFuseMs: state.fuseMs,
  deadline: ctx.now + state.fuseMs,
  used: [],
  chain: [],
  lastMiss: null,
  popped: null,
});

const finishFuse = (state: LongShotState): LongShotState => {
  const survivors = alivePlayers(state);
  const winnerId = state.order.length > 1 && survivors.length === 1 ? survivors[0] : null;
  const scores = { ...state.scores };
  if (winnerId) scores[winnerId] = (scores[winnerId] ?? 0) + SURVIVOR_BONUS;
  return { ...state, phase: "results", scores, winnerId, turnPlayerId: null, deadline: 0 };
};

const popFuse = (state: LongShotState, ctx: GameContext): LongShotState => {
  const holder = state.turnPlayerId;
  if (!holder) return finishFuse(state);
  const remaining = Math.max(0, (state.lives[holder] ?? 0) - 1);
  const lives = { ...state.lives, [holder]: remaining };
  const eliminated = remaining === 0;
  return {
    ...state,
    phase: "popped",
    lives,
    outOrder: eliminated ? [...state.outOrder, holder] : state.outOrder,
    popped: { playerId: holder, eliminated },
    deadline: ctx.now + POPPED_MS,
  };
};

const afterPop = (state: LongShotState, ctx: GameContext): LongShotState => {
  if (fuseIsOver(state)) return finishFuse(state);
  const holder = state.popped?.playerId ?? state.turnPlayerId;
  const starter =
    holder && (state.lives[holder] ?? 0) > 0 && isActive(ctx, holder)
      ? holder
      : nextAliveConnected(state, holder, ctx);
  return enterFuse(state, state.promptIndex + 1, starter, ctx);
};

export type LongShotMove =
  | { type: "start" }
  | { type: "answer"; text: string }
  | { type: "skip" }
  | { type: "next" };

const decodeLongShotMove = (move: GameMove): LongShotMove => {
  switch (move.type) {
    case "start":
    case "skip":
    case "next":
      return { type: move.type };
    case "answer": {
      const text = requireString(payloadField(move.payload, "text"), "Type an answer").trim();
      if (!text) throw new GameMoveError("Type an answer");
      return { type: "answer", text: text.slice(0, MAX_ANSWER_LENGTH) };
    }
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

const answerClassic = (
  state: LongShotState,
  playerId: string,
  text: string,
  ctx: GameContext,
): LongShotState => {
  if (state.phase !== "prompt") throw new GameMoveError("Not accepting answers right now");
  const prompt = currentPrompt(state);
  if (!prompt) throw new GameMoveError("No prompt");
  const previous = state.entries[playerId];
  if (previous?.answer) throw new GameMoveError("You already locked in");
  if ((previous?.misses ?? 0) >= MAX_TRIES) throw new GameMoveError("No tries left");
  const match = matchAnswer(prompt, text);
  const entry: ClassicEntry = match
    ? { answer: match, misses: previous?.misses ?? 0, lastMiss: null, at: ctx.now }
    : {
        answer: null,
        misses: (previous?.misses ?? 0) + 1,
        lastMiss: { text, reason: "unknown", at: ctx.now },
        at: ctx.now,
      };
  const entries = { ...state.entries, [playerId]: entry };
  const everyone = allActivePlayersActed(ctx, (id) => classicLocked(entries[id]));
  return { ...state, entries, deadline: everyone ? ctx.now : state.deadline };
};

const answerFuse = (
  state: LongShotState,
  playerId: string,
  text: string,
  ctx: GameContext,
): LongShotState => {
  if (state.phase !== "fuse") throw new GameMoveError("The fuse is not lit");
  if (state.turnPlayerId !== playerId) throw new GameMoveError("Not your turn");
  const prompt = currentPrompt(state);
  if (!prompt) throw new GameMoveError("No prompt");
  const match = matchAnswer(prompt, text);
  if (!match) {
    return { ...state, lastMiss: { playerId, text, reason: "unknown", at: ctx.now } };
  }
  if (state.used.includes(match.id)) {
    return {
      ...state,
      lastMiss: { playerId, text: match.display, reason: "used", at: ctx.now },
    };
  }
  const points = LONG_SHOT_TIER_POINTS[match.tier];
  const used = [...state.used, match.id];
  const chain = [...state.chain, { playerId, answer: match.display, tier: match.tier, points }].slice(
    -CHAIN_LENGTH,
  );
  const scores = { ...state.scores, [playerId]: (state.scores[playerId] ?? 0) + points };
  const best = recordBest(state.best, playerId, match, prompt, points);
  const currentFuseMs = Math.max(MIN_FUSE_MS, state.currentFuseMs - FUSE_SHRINK_MS);
  const base = { ...state, used, chain, scores, best, lastMiss: null };
  if (used.length >= prompt.answers.length) {
    return enterFuse(base, state.promptIndex + 1, nextAliveConnected(base, playerId, ctx), ctx);
  }
  const solo = state.order.length === 1;
  return {
    ...base,
    currentFuseMs,
    turnPlayerId: solo ? playerId : nextAliveConnected(base, playerId, ctx),
    deadline: ctx.now + currentFuseMs,
  };
};

export const longShotModule: GameModule<LongShotState> = {
  id: "long-shot",
  name: "Long Shot",
  description: "Rare answers score big",
  minPlayers: 1,
  maxPlayers: 24,
  tickMs: 250,
  hasLeaderboard: true,
  lateJoinPhases: (state) => (state.mode === "classic" ? ["prompt"] : []),
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    {
      id: "mode",
      type: "select",
      label: "Mode",
      default: "classic",
      choices: [
        { value: "classic", label: "Dive together" },
        { value: "fuse", label: "Last one under" },
      ],
    },
    {
      id: "prompts",
      type: "number",
      label: "Prompts",
      min: 3,
      max: 12,
      default: DEFAULT_PROMPTS,
      presets: [5, 7, 10],
      showWhen: { id: "mode", equals: ["classic"] },
    },
    {
      id: "lives",
      type: "number",
      label: "Lives",
      min: 1,
      max: 3,
      default: DEFAULT_LIVES,
      presets: [1, 2, 3],
      showWhen: { id: "mode", equals: ["fuse"] },
    },
    {
      id: "pace",
      type: "select",
      label: "Pace",
      default: "normal",
      choices: [
        { value: "relaxed", label: "Relaxed" },
        { value: "normal", label: "Normal" },
        { value: "fast", label: "Fast" },
      ],
    },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config);
    if (!topic) return Promise.resolve(null);
    const mode = selectOption(ctx.config, "mode", "classic");
    const count =
      mode === "fuse"
        ? FUSE_GENERATED_PROMPTS
        : numberOption(ctx.config, "prompts", DEFAULT_PROMPTS);
    return generateStructuredGameContent({
      signal: ctx.signal,
      aiEnvironment: ctx.aiEnvironment,
      gameName: "Long Shot",
      topic,
      instructions: [
        `Create ${count} open-ended "Name a ..." prompts for a rare-answer game about the topic.`,
        "Each prompt must have a large, finite, verifiable set of correct answers (for example 'Name a character from X' or 'Name a city in Y').",
        "Sort the accepted answers into four tiers by how many people would think of them: obvious (the first answers nearly everyone says), solid, rare, and longShot (correct but almost nobody would think of it).",
        "Every listed answer must be factually correct for its prompt. Never repeat an answer across tiers.",
        "List as many correct answers as you reliably can, especially in the rare and longShot tiers.",
        "Write each answer as its most common name. Add alternate spellings after a pipe, like 'Kyiv|Kiev'.",
      ].join(" "),
      schemaName: "long_shot_prompts",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompts: {
            type: "array",
            minItems: count,
            maxItems: count,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: { type: "string", maxLength: 32 },
                prompt: { type: "string", maxLength: 100 },
                obvious: tierSchema("obvious"),
                solid: tierSchema("solid"),
                rare: tierSchema("rare"),
                longShot: tierSchema("longShot"),
              },
              required: ["category", "prompt", "obvious", "solid", "rare", "longShot"],
            },
          },
        },
        required: ["prompts"],
      },
      maxOutputTokens: 800 + count * 900,
      parse: (payload) => parseGeneratedPrompts(payload, Math.min(count, 3)),
    });
  },

  setup(ctx: GameContext): LongShotState {
    const mode = selectOption(ctx.config, "mode", "classic") === "fuse" ? "fuse" : "classic";
    const pace = selectOption(ctx.config, "pace", "normal");
    const generated = Array.isArray(ctx.content) ? (ctx.content as LongShotPrompt[]) : [];
    const source = generated.length > 0 ? generated : LONG_SHOT_BANK;
    const wanted =
      mode === "classic" ? numberOption(ctx.config, "prompts", DEFAULT_PROMPTS) : source.length;
    const prompts = ctx.rng
      .shuffle(source)
      .slice(0, Math.min(wanted, source.length))
      .map(compilePrompt);
    const fuseMs = FUSE_PACE_MS[pace] ?? FUSE_PACE_MS.normal;
    const scores: Record<string, number> = {};
    for (const player of ctx.players) scores[player.id] = 0;
    return {
      mode,
      phase: "lobby",
      prompts,
      promptIndex: 0,
      totalPrompts: prompts.length,
      deadline: 0,
      scores,
      best: {},
      promptMs: CLASSIC_PACE_MS[pace] ?? CLASSIC_PACE_MS.normal,
      entries: {},
      results: [],
      missedGems: [],
      obviousPicks: [],
      fuseMs,
      currentFuseMs: fuseMs,
      maxLives: numberOption(ctx.config, "lives", DEFAULT_LIVES),
      order: [],
      turnPlayerId: null,
      lives: {},
      used: [],
      chain: [],
      lastMiss: null,
      popped: null,
      outOrder: [],
      winnerId: null,
    };
  },

  onMove(state, move: GameMove, ctx): LongShotState {
    const m = decodeLongShotMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("Already running");
        }
        if (state.prompts.length === 0) {
          throw new GameMoveError("No prompts available");
        }
        if (state.mode === "classic") return enterPrompt(state, 0, ctx);
        const order = ctx.rng.shuffle(ctx.players.map((player) => player.id));
        const lives: Record<string, number> = {};
        for (const playerId of order) lives[playerId] = state.maxLives;
        const seeded = { ...state, order, lives };
        const first = order.find((playerId) => isActive(ctx, playerId)) ?? order[0] ?? null;
        return enterFuse(seeded, 0, first, ctx);
      }
      case "answer":
        return state.mode === "classic"
          ? answerClassic(state, move.playerId, m.text, ctx)
          : answerFuse(state, move.playerId, m.text, ctx);
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can skip");
        }
        if (state.phase === "prompt") return { ...state, deadline: ctx.now };
        if (state.phase === "fuse") {
          return enterFuse(state, state.promptIndex + 1, state.turnPlayerId, ctx);
        }
        throw new GameMoveError("Nothing to skip");
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can advance");
        }
        if (state.phase !== "reveal" && state.phase !== "popped") {
          throw new GameMoveError("Wait for the reveal");
        }
        return { ...state, deadline: ctx.now };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): LongShotState {
    switch (state.phase) {
      case "prompt":
        return ctx.now >= state.deadline ? scoreClassicRound(state, ctx) : state;
      case "reveal": {
        if (ctx.now < state.deadline) return state;
        const nextIndex = state.promptIndex + 1;
        if (nextIndex >= state.prompts.length) return { ...state, phase: "results", deadline: 0 };
        return enterPrompt(state, nextIndex, ctx);
      }
      case "fuse": {
        const holder = state.turnPlayerId;
        if (holder && !isActive(ctx, holder)) {
          const next = nextAliveConnected(state, holder, ctx);
          if (next && next !== holder && isActive(ctx, next)) {
            return { ...state, turnPlayerId: next, deadline: ctx.now + state.currentFuseMs };
          }
          return state;
        }
        return ctx.now >= state.deadline ? popFuse(state, ctx) : state;
      }
      case "popped":
        return ctx.now >= state.deadline ? afterPop(state, ctx) : state;
      case "lobby":
      case "results":
        return state;
    }
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const prompt = currentPrompt(state);
    const live = state.phase !== "lobby" && state.phase !== "results";
    const name = (playerId: string) => playerName(ctx, playerId);

    const tiles: Record<
      string,
      {
        acted?: boolean;
        outcome?: "correct" | "wrong";
        note?: string;
        active?: boolean;
        eliminated?: boolean;
        winner?: boolean;
      }
    > = {};
    if (state.mode === "classic") {
      if (state.phase === "prompt") {
        for (const [playerId, entry] of Object.entries(state.entries)) {
          if (classicLocked(entry)) tiles[playerId] = { acted: true };
        }
      } else if (state.phase === "reveal") {
        for (const result of state.results) {
          tiles[result.playerId] = result.answer
            ? { outcome: "correct", note: `${result.points}m` }
            : { outcome: "wrong" };
        }
      }
    } else if (state.order.length > 0) {
      for (const playerId of state.order) {
        if ((state.lives[playerId] ?? 0) <= 0) {
          tiles[playerId] = { eliminated: true, note: "Surfaced" };
        } else if (state.phase === "fuse" && state.turnPlayerId === playerId) {
          tiles[playerId] = { active: true, note: "Holding breath" };
        }
      }
      if (state.phase === "popped" && state.popped && !state.popped.eliminated) {
        tiles[state.popped.playerId] = { outcome: "wrong", note: "Out of air" };
      }
      if (state.phase === "results" && state.winnerId) {
        tiles[state.winnerId] = { winner: true, note: "Last one under" };
      }
    }

    const lockedCount = Object.values(state.entries).filter(classicLocked).length;

    return {
      mode: state.mode,
      phase: state.phase,
      serverNow: ctx.now,
      deadline: live && state.deadline > 0 ? state.deadline : null,
      durationMs: state.mode === "classic" ? state.promptMs : state.currentFuseMs,
      promptIndex: state.promptIndex,
      totalPrompts: state.totalPrompts,
      category: live ? prompt?.category ?? null : null,
      prompt: live ? prompt?.prompt ?? null : null,
      tierCounts: live ? tierCounts(prompt) : null,
      tierPoints: LONG_SHOT_TIER_POINTS,
      onlyYouBonus: ONLY_YOU_BONUS,
      maxTries: MAX_TRIES,
      answeredCount: lockedCount,
      totalPlayers: ctx.activePlayers.length,
      results:
        state.phase === "reveal"
          ? state.results.map((result) => ({ ...result, id: result.playerId, name: name(result.playerId) }))
          : [],
      missedGems: state.phase === "reveal" ? state.missedGems : [],
      obviousPicks: state.phase === "reveal" ? state.obviousPicks : [],
      turnPlayerId: state.phase === "fuse" ? state.turnPlayerId : null,
      maxLives: state.maxLives,
      seats: state.order.map((playerId) => ({
        id: playerId,
        name: name(playerId),
        lives: state.lives[playerId] ?? 0,
        out: (state.lives[playerId] ?? 0) <= 0,
      })),
      chain: state.chain.map((link) => ({ ...link, name: name(link.playerId) })),
      usedCount: state.used.length,
      lastMiss: state.lastMiss
        ? {
            playerId: state.lastMiss.playerId,
            name: name(state.lastMiss.playerId),
            text: state.lastMiss.text,
            reason: state.lastMiss.reason,
            at: state.lastMiss.at,
          }
        : null,
      popped: state.popped
        ? { ...state.popped, name: name(state.popped.playerId) }
        : null,
      winnerId: state.winnerId,
      survivorBonus: SURVIVOR_BONUS,
      best:
        state.phase === "results"
          ? Object.entries(state.best)
              .map(([playerId, entry]) => ({ id: playerId, name: name(playerId), ...entry }))
              .sort((a, b) => b.points - a.points)
          : [],
      scoreboard: scoreboard(state, ctx),
      tiles,
    };
  },

  playerView(state, playerId, ctx) {
    const entry = state.entries[playerId];
    const ordered = scoreboard(state, ctx);
    const rank = ordered.findIndex((row) => row.id === playerId);
    const result = state.results.find((row) => row.playerId === playerId) ?? null;
    return {
      score: state.scores[playerId] ?? 0,
      rank: rank >= 0 ? rank + 1 : null,
      answer: entry?.answer
        ? {
            text: entry.answer.display,
            tier: entry.answer.tier,
            points: LONG_SHOT_TIER_POINTS[entry.answer.tier],
          }
        : null,
      misses: entry?.misses ?? 0,
      triesLeft: Math.max(0, MAX_TRIES - (entry?.misses ?? 0)),
      locked: classicLocked(entry),
      lastMiss: entry?.lastMiss ?? null,
      roundPoints: result?.points ?? 0,
      roundBonus: result?.bonus ?? 0,
      shared: result?.shared ?? false,
      yourTurn: state.phase === "fuse" && state.turnPlayerId === playerId,
      lives: state.lives[playerId] ?? 0,
    };
  },

  isFinished: (state) => state.phase === "results",
};
