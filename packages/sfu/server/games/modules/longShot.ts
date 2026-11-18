import {
  GameMoveError,
  type GameContext,
  type GameDecider,
  type GameModule,
  type GameMove,
  type GamePendingMove,
  type GamePrepareContext,
} from "../types.js";
import { payloadField, requireString } from "../validation.js";
import { numberOption, selectOption } from "../config.js";
import { allActivePlayersActed } from "../roundLoop.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  GameContentGenerationError,
  cleanGeneratedStringArray,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";
import {
  LONG_SHOT_BANK,
  LONG_SHOT_TIER_POINTS,
  LONG_SHOT_LIST_TIERS,
  compilePrompt,
  matchAnswer,
  normalizeAnswer,
  type CompiledAnswer,
  type CompiledPrompt,
  type LongShotListTier,
  type LongShotPrompt,
  type LongShotTier,
} from "../longShotBank.js";
import {
  buildJudgePlan,
  decodeJudgedMove,
  tidyJudgedText,
  verdictFromAnswers,
  type JudgedMove,
  type JudgeVerdict,
} from "../longShotJudge.js";
import { createGameDecider } from "../decisions.js";

type Mode = "classic" | "fuse";
type Phase = "lobby" | "ready" | "prompt" | "reveal" | "fuse" | "popped" | "results";

const CLASSIC_PACE_MS: Record<string, number> = { relaxed: 40_000, normal: 25_000, fast: 15_000 };
const FUSE_RANGE_MS: Record<string, [number, number]> = {
  relaxed: [15_000, 40_000],
  normal: [10_000, 30_000],
  fast: [6_000, 18_000],
};
const READY_MS = 3_000;
const REVEAL_MS = 9_000;
const POPPED_MS = 2_800;
const MIN_TURN_MS = 8_000;
const MAX_ANSWER_LENGTH = 48;
const SURVIVOR_BONUS = 2000;
const HEART_METER = 6_000;
const MAX_HEARTS = 5;
const CHAIN_LENGTH = 10;
const DEFAULT_PROMPTS = 7;
const DEFAULT_LIVES = 2;
const FUSE_GENERATED_PROMPTS = 8;
const ABSENT_FORFEIT_MS = 30_000;
const JUDGES_PER_PLAYER_PROMPT = 6;
const JUDGES_PER_GAME = 400;
const GENERATED_ANSWER_THRESHOLD = 0.3;
const RESUME_MIN_MS = 3_000;

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
  judged?: boolean;
};

type ChainLink = {
  playerId: string;
  answer: string;
  tier: LongShotTier;
  points: number;
  judged?: boolean;
};

type BestAnswer = {
  answer: string;
  tier: LongShotTier;
  prompt: string;
  points: number;
  judged?: boolean;
};

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
  fuseRange: [number, number];
  maxLives: number;
  meter: Record<string, number>;
  lastHeart: { playerId: string; at: number } | null;
  order: string[];
  turnPlayerId: string | null;
  lives: Record<string, number>;
  used: string[];
  chain: ChainLink[];
  lastMiss: (Miss & { playerId: string }) | null;
  popped: { playerId: string; eliminated: boolean } | null;
  outOrder: string[];
  winnerId: string | null;
  absentSince: Record<string, number>;
  pausedRemainingMs: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const TIER_LIMITS: Record<LongShotListTier, { min: number; max: number }> = {
  obvious: { min: 3, max: 12 },
  cliche: { min: 1, max: 6 },
  solid: { min: 4, max: 20 },
  rare: { min: 5, max: 25 },
  longShot: { min: 6, max: 30 },
};

export const LONG_SHOT_MIN_ANSWERS =
  LONG_SHOT_LIST_TIERS.reduce((sum, tier) => sum + TIER_LIMITS[tier].min, 0) + 1;

export const parseLongShotPrompts = (payload: unknown, minItems = 1): LongShotPrompt[] | null => {
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
    const pearl = cleanGeneratedText(item.pearl, 80);
    if (!pearl) continue;
    const tiers = {} as Record<LongShotListTier, string[]>;
    let valid = true;
    for (const tier of LONG_SHOT_LIST_TIERS) {
      const list = cleanGeneratedStringArray(item[tier], {
        maxItems: TIER_LIMITS[tier].max,
        maxLength: 80,
      });
      if (list.length < TIER_LIMITS[tier].min) valid = false;
      tiers[tier] = list;
    }
    if (!valid) continue;
    const raw: LongShotPrompt = { category, prompt, ...tiers, pearl };
    if (compilePrompt(raw).answers.length < LONG_SHOT_MIN_ANSWERS) continue;
    seenPrompts.add(promptKey);
    out.push(raw);
    if (out.length >= 15) break;
  }
  return out.length >= minItems ? out : null;
};

const tierSchema = (tier: LongShotListTier) => ({
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
  const counts: Record<LongShotTier, number> = {
    obvious: 0,
    cliche: 0,
    solid: 0,
    rare: 0,
    longShot: 0,
    pearl: 0,
  };
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
    [playerId]: {
      answer: answer.display,
      tier: answer.tier,
      prompt: prompt.prompt,
      points,
      ...(answer.judged ? { judged: true } : {}),
    },
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

const enterReady = (state: LongShotState, index: number, ctx: GameContext): LongShotState => ({
  ...state,
  phase: "ready",
  promptIndex: index,
  deadline: ctx.now + READY_MS,
  entries: {},
  results: [],
  missedGems: [],
  obviousPicks: [],
});

const classicLocked = (entry: ClassicEntry | undefined): boolean => Boolean(entry?.answer);

const scoreClassicRound = (state: LongShotState, ctx: GameContext): LongShotState => {
  const prompt = currentPrompt(state);
  if (!prompt) return { ...state, phase: "reveal", deadline: ctx.now + REVEAL_MS };
  const scores = { ...state.scores };
  let best = state.best;
  const results: RoundResult[] = [];
  for (const [playerId, entry] of Object.entries(state.entries)) {
    if (!entry.answer) {
      results.push({ playerId, answer: null, tier: null, points: 0 });
      continue;
    }
    const points = LONG_SHOT_TIER_POINTS[entry.answer.tier];
    scores[playerId] = (scores[playerId] ?? 0) + points;
    best = recordBest(best, playerId, entry.answer, prompt, points);
    results.push({
      playerId,
      answer: entry.answer.display,
      tier: entry.answer.tier,
      points,
      ...(entry.answer.judged ? { judged: true } : {}),
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
  deadline:
    ctx.now + state.fuseRange[0] + ctx.rng.int(state.fuseRange[1] - state.fuseRange[0] + 1),
  used: [],
  chain: [],
  lastMiss: null,
  popped: null,
  pausedRemainingMs: null,
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

const forfeitAbsent = (state: LongShotState, ctx: GameContext): LongShotState => {
  let absentSince = state.absentSince;
  let lives = state.lives;
  let outOrder = state.outOrder;
  let changed = false;
  for (const playerId of alivePlayers(state)) {
    const since = absentSince[playerId];
    if (isActive(ctx, playerId)) {
      if (since !== undefined) {
        const rest = { ...absentSince };
        delete rest[playerId];
        absentSince = rest;
        changed = true;
      }
      continue;
    }
    if (since === undefined) {
      absentSince = { ...absentSince, [playerId]: ctx.now };
      changed = true;
    } else if (ctx.now - since >= ABSENT_FORFEIT_MS) {
      lives = { ...lives, [playerId]: 0 };
      outOrder = [...outOrder, playerId];
      changed = true;
    }
  }
  return changed ? { ...state, absentSince, lives, outOrder } : state;
};

const tickFuse = (state: LongShotState, ctx: GameContext): LongShotState => {
  const tracked = forfeitAbsent(state, ctx);
  if (fuseIsOver(tracked)) return finishFuse(tracked);
  const alive = alivePlayers(tracked);
  const connected = alive.filter((playerId) => isActive(ctx, playerId));
  const waiting = connected.length === 0 || (alive.length > 1 && connected.length < 2);
  if (waiting) {
    if (tracked.pausedRemainingMs !== null) return tracked;
    return { ...tracked, pausedRemainingMs: Math.max(0, tracked.deadline - ctx.now) };
  }
  const holder = tracked.turnPlayerId;
  if (!holder || !connected.includes(holder)) {
    return {
      ...tracked,
      turnPlayerId: nextAliveConnected(tracked, holder, ctx),
      deadline: Math.max(tracked.deadline, ctx.now + RESUME_MIN_MS),
      pausedRemainingMs: null,
    };
  }
  if (tracked.pausedRemainingMs !== null) {
    return {
      ...tracked,
      pausedRemainingMs: null,
      deadline: ctx.now + Math.max(RESUME_MIN_MS, tracked.pausedRemainingMs),
    };
  }
  return ctx.now >= tracked.deadline ? popFuse(tracked, ctx) : tracked;
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

const judgeBudgetKey = (state: LongShotState, playerId: string) =>
  `judge:${state.promptIndex}:${playerId}`;

const spendJudgeBudget = (cache: Map<string, unknown>, key: string, limit: number): boolean => {
  const used = typeof cache.get(key) === "number" ? (cache.get(key) as number) : 0;
  if (used >= limit) return false;
  cache.set(key, used + 1);
  return true;
};

export const prepareLongShotAnswer = async (
  state: LongShotState,
  move: GameMove,
  ctx: GamePrepareContext,
): Promise<{ judge: JudgedMove } | null> => {
  if (move.type !== "answer" || !ctx.decide) return null;
  const raw = payloadField(move.payload, "text");
  if (typeof raw !== "string") return null;
  const text = raw.trim().slice(0, MAX_ANSWER_LENGTH);
  const answerable =
    (state.phase === "prompt" && !state.entries[move.playerId]?.answer) ||
    (state.phase === "fuse" && state.turnPlayerId === move.playerId);
  if (!text || !answerable) return null;
  const prompt = currentPrompt(state);
  if (!prompt || matchAnswer(prompt, text)) return null;
  const key = normalizeAnswer(text);
  if (key.length < 2) return null;
  const used =
    state.mode === "fuse"
      ? prompt.answers.filter((answer) => state.used.includes(answer.id))
      : [];
  const cacheKey = `verdict:${state.promptIndex}:${prompt.prompt}:${key}:${used.map((answer) => answer.id).join(",")}`;
  const bound = { key, promptIndex: state.promptIndex, prompt: prompt.prompt };
  const cached = ctx.cache.get(cacheKey) as JudgeVerdict | undefined;
  if (cached) return { judge: { ...bound, verdict: cached } };
  if (!spendJudgeBudget(ctx.cache, judgeBudgetKey(state, move.playerId), JUDGES_PER_PLAYER_PROMPT)) return null;
  if (!spendJudgeBudget(ctx.cache, "judge:game", JUDGES_PER_GAME)) return null;
  const plan = buildJudgePlan(prompt, text, used);
  const answers = await ctx.decide({ state: plan.state, questions: plan.questions, signal: ctx.signal });
  const verdict = verdictFromAnswers(plan, answers);
  ctx.cache.set(cacheKey, verdict);
  return { judge: { ...bound, verdict } };
};

export const holdLongShotTick = (
  state: LongShotState,
  pending: GamePendingMove[],
): boolean => {
  if (state.phase === "prompt") {
    return pending.some(
      (move) => move.receivedAt < state.deadline && !state.entries[move.playerId]?.answer,
    );
  }
  if (state.phase === "fuse" && state.pausedRemainingMs === null) {
    return pending.some(
      (move) => move.playerId === state.turnPlayerId && move.receivedAt < state.deadline,
    );
  }
  return false;
};

export const filterGeneratedPrompts = async (
  prompts: LongShotPrompt[],
  decide: GameDecider,
  signal?: AbortSignal,
): Promise<LongShotPrompt[]> => {
  const checked = await Promise.all(
    prompts.map(async (prompt) => {
      const entries: { tier: LongShotListTier | "pearl"; value: string }[] = [
        ...LONG_SHOT_LIST_TIERS.flatMap((tier) => prompt[tier].map((value) => ({ tier, value }))),
        { tier: "pearl", value: prompt.pearl },
      ];
      const questions = Object.fromEntries(
        entries.map((entry, index) => [
          `a${index}`,
          {
            type: "noul" as const,
            instructions: {
              question: "Is `answer` a correct answer to the prompt in the state?",
              answer: entry.value.split("|")[0],
            },
            criteria: {
              true: "The answer names a real, specific thing that satisfies the prompt.",
              false: "The answer is wrong, invented, too vague, or does not fit the prompt.",
            },
          },
        ]),
      );
      try {
        const answers = await decide({ state: { prompt: prompt.prompt, category: prompt.category }, questions, signal });
        const keep = (index: number) => {
          const answer = answers[`a${index}`];
          return !answer || answer.type !== "noul" || answer.noul >= GENERATED_ANSWER_THRESHOLD;
        };
        const filtered: LongShotPrompt = { ...prompt };
        for (const tier of LONG_SHOT_LIST_TIERS) {
          filtered[tier] = prompt[tier].filter((value) =>
            keep(entries.findIndex((entry) => entry.tier === tier && entry.value === value)),
          );
        }
        if (!keep(entries.length - 1)) return null;
        return filtered;
      } catch {
        return prompt;
      }
    }),
  );
  return parseLongShotPrompts({ prompts: checked.filter((prompt): prompt is LongShotPrompt => Boolean(prompt)) }) ?? [];
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

type ResolvedAnswer = {
  state: LongShotState;
  match: CompiledAnswer | null;
  repeatOf: CompiledAnswer | null;
};

const resolveAnswer = (
  state: LongShotState,
  prompt: CompiledPrompt,
  text: string,
  judged: JudgedMove | null,
): ResolvedAnswer => {
  const listed = matchAnswer(prompt, text);
  if (listed) return { state, match: listed, repeatOf: null };
  const key = normalizeAnswer(text);
  if (
    !judged ||
    !key ||
    judged.key !== key ||
    judged.promptIndex !== state.promptIndex ||
    judged.prompt !== prompt.prompt
  ) {
    return { state, match: null, repeatOf: null };
  }
  const { verdict } = judged;
  const find = (id: string) => prompt.answers.find((answer) => answer.id === id) ?? null;
  if (verdict.kind === "alias") return { state, match: find(verdict.answerId), repeatOf: null };
  if (verdict.kind === "repeat") return { state, match: null, repeatOf: find(verdict.answerId) };
  if (verdict.kind !== "accept") return { state, match: null, repeatOf: null };
  const known = prompt.answers.find((answer) => answer.keys.includes(key));
  if (known) return { state, match: known, repeatOf: null };
  const answer: CompiledAnswer = {
    id: `judged:${key}`,
    display: tidyJudgedText(text).slice(0, MAX_ANSWER_LENGTH),
    tier: verdict.tier,
    keys: [key],
    judged: true,
  };
  const prompts = state.prompts.slice();
  prompts[state.promptIndex % prompts.length] = { ...prompt, answers: [...prompt.answers, answer] };
  return { state: { ...state, prompts }, match: answer, repeatOf: null };
};

const answerClassic = (
  state: LongShotState,
  playerId: string,
  text: string,
  ctx: GameContext,
  judged: JudgedMove | null,
  receivedAt: number,
): LongShotState => {
  if (state.phase === "ready") throw new GameMoveError("Get ready");
  if (state.phase !== "prompt") throw new GameMoveError("Not accepting answers right now");
  if (receivedAt >= state.deadline) throw new GameMoveError("Time's up");
  const prompt = currentPrompt(state);
  if (!prompt) throw new GameMoveError("No prompt");
  const previous = state.entries[playerId];
  if (previous?.answer) throw new GameMoveError("You already locked in");
  const resolved = resolveAnswer(state, prompt, text, judged);
  state = resolved.state;
  const match = resolved.match;
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
  judged: JudgedMove | null,
  receivedAt: number,
): LongShotState => {
  if (state.phase !== "fuse") throw new GameMoveError("The fuse is not lit");
  if (state.turnPlayerId !== playerId) throw new GameMoveError("Not your turn");
  if (state.pausedRemainingMs !== null) throw new GameMoveError("Waiting for players");
  if (receivedAt >= state.deadline) throw new GameMoveError("Time's up");
  const currentPromptValue = currentPrompt(state);
  if (!currentPromptValue) throw new GameMoveError("No prompt");
  const resolved = resolveAnswer(state, currentPromptValue, text, judged);
  if (resolved.repeatOf) {
    return {
      ...state,
      lastMiss: { playerId, text: resolved.repeatOf.display, reason: "used", at: ctx.now },
    };
  }
  state = resolved.state;
  const prompt = currentPrompt(state)!;
  const match = resolved.match;
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
  const chain = [
    ...state.chain,
    { playerId, answer: match.display, tier: match.tier, points, ...(match.judged ? { judged: true } : {}) },
  ].slice(
    -CHAIN_LENGTH,
  );
  const scores = { ...state.scores, [playerId]: (state.scores[playerId] ?? 0) + points };
  const best = recordBest(state.best, playerId, match, prompt, points);
  let hearts = state.lives[playerId] ?? 0;
  let meter = (state.meter[playerId] ?? 0) + points;
  let lastHeart = state.lastHeart;
  while (meter >= HEART_METER && hearts < MAX_HEARTS) {
    meter -= HEART_METER;
    hearts += 1;
    lastHeart = { playerId, at: ctx.now };
  }
  if (hearts >= MAX_HEARTS) meter = Math.min(meter, HEART_METER);
  const base = {
    ...state,
    used,
    chain,
    scores,
    best,
    lastMiss: null,
    lives: { ...state.lives, [playerId]: hearts },
    meter: { ...state.meter, [playerId]: meter },
    lastHeart,
  };
  if (used.length >= prompt.answers.length) {
    return enterFuse(base, state.promptIndex + 1, nextAliveConnected(base, playerId, ctx), ctx);
  }
  const solo = state.order.length === 1;
  return {
    ...base,
    turnPlayerId: solo ? playerId : nextAliveConnected(base, playerId, ctx),
    deadline: Math.max(state.deadline, ctx.now + MIN_TURN_MS),
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
  lateJoinPhases: (state) => (state.mode === "classic" ? ["ready"] : []),
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
      label: "Hearts",
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
        "Sort the accepted answers by how many people would think of them: obvious (the first answers nearly everyone says), cliche (the famously 'obscure' picks everyone reaches for when trying to be clever), solid, rare, and longShot (correct but almost nobody would think of it).",
        "Also choose one pearl per prompt: a single designated gem answer, deep and satisfying to land on, that at least a few people could plausibly get. It must not appear in any other tier.",
        "Every listed answer must be factually correct for its prompt. Never repeat an answer across tiers.",
        `Give every prompt at least ${LONG_SHOT_MIN_ANSWERS} distinct answers including the pearl: at least ${TIER_LIMITS.obvious.min} obvious, ${TIER_LIMITS.cliche.min} cliche, ${TIER_LIMITS.solid.min} solid, ${TIER_LIMITS.rare.min} rare and ${TIER_LIMITS.longShot.min} longShot.`,
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
                cliche: tierSchema("cliche"),
                solid: tierSchema("solid"),
                rare: tierSchema("rare"),
                longShot: tierSchema("longShot"),
                pearl: { type: "string", maxLength: 80 },
              },
              required: ["category", "prompt", "obvious", "cliche", "solid", "rare", "longShot", "pearl"],
            },
          },
        },
        required: ["prompts"],
      },
      maxOutputTokens: 800 + count * 900,
      parse: (payload) => parseLongShotPrompts(payload, Math.min(count, 3)),
    }).then(async (prompts) => {
      const decide = ctx.aiEnvironment ? createGameDecider(ctx.aiEnvironment) : null;
      if (!prompts || !decide) return prompts;
      const filtered = await filterGeneratedPrompts(prompts, decide, ctx.signal);
      if (filtered.length === 0) {
        throw new GameContentGenerationError(
          "Not enough answers for that topic held up. Try another topic.",
        );
      }
      return filtered;
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
      fuseRange: FUSE_RANGE_MS[pace] ?? FUSE_RANGE_MS.normal,
      maxLives: numberOption(ctx.config, "lives", DEFAULT_LIVES),
      meter: {},
      lastHeart: null,
      order: [],
      turnPlayerId: null,
      lives: {},
      used: [],
      chain: [],
      lastMiss: null,
      popped: null,
      outOrder: [],
      winnerId: null,
      absentSince: {},
      pausedRemainingMs: null,
    };
  },

  prepareMove: prepareLongShotAnswer,
  holdTick: holdLongShotTick,

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
        if (state.mode === "classic") return enterReady(state, 0, ctx);
        if (ctx.players.length < 2) throw new GameMoveError("Last one under needs at least 2 players");
        const order = ctx.rng.shuffle(ctx.players.map((player) => player.id));
        const lives: Record<string, number> = {};
        for (const playerId of order) lives[playerId] = state.maxLives;
        const seeded = { ...state, order, lives };
        const first = order.find((playerId) => isActive(ctx, playerId)) ?? order[0] ?? null;
        return enterFuse(seeded, 0, first, ctx);
      }
      case "answer": {
        const judged = decodeJudgedMove(move.verified);
        const receivedAt = Math.min(move.receivedAt ?? ctx.now, ctx.now);
        return state.mode === "classic"
          ? answerClassic(state, move.playerId, m.text, ctx, judged, receivedAt)
          : answerFuse(state, move.playerId, m.text, ctx, judged, receivedAt);
      }
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can skip");
        }
        if (state.phase === "prompt") return { ...state, deadline: ctx.now };
        if (state.phase === "fuse") {
          const holder = state.turnPlayerId;
          const starter =
            holder && isActive(ctx, holder) ? holder : nextAliveConnected(state, holder, ctx);
          return enterFuse(state, state.promptIndex + 1, starter, ctx);
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
      case "ready":
        return ctx.now >= state.deadline
          ? { ...state, phase: "prompt", deadline: ctx.now + state.promptMs }
          : state;
      case "prompt":
        return ctx.now >= state.deadline ? scoreClassicRound(state, ctx) : state;
      case "reveal": {
        if (ctx.now < state.deadline) return state;
        const nextIndex = state.promptIndex + 1;
        if (nextIndex >= state.prompts.length) return { ...state, phase: "results", deadline: 0 };
        return enterReady(state, nextIndex, ctx);
      }
      case "fuse":
        return tickFuse(state, ctx);
      case "popped": {
        const tracked = forfeitAbsent(state, ctx);
        return ctx.now >= tracked.deadline ? afterPop(tracked, ctx) : tracked;
      }
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
      deadline: live && state.phase !== "fuse" && state.deadline > 0 ? state.deadline : null,
      paused: state.phase === "fuse" && state.pausedRemainingMs !== null,
      durationMs: state.phase === "ready" ? READY_MS : state.promptMs,
      promptIndex: state.promptIndex,
      totalPrompts: state.totalPrompts,
      category: live ? prompt?.category ?? null : null,
      prompt: live ? prompt?.prompt ?? null : null,
      tierCounts: live ? tierCounts(prompt) : null,
      tierPoints: LONG_SHOT_TIER_POINTS,
      answeredCount: lockedCount,
      totalPlayers: ctx.activePlayers.length,
      results:
        state.phase === "reveal"
          ? state.results.map((result) => ({ ...result, id: result.playerId, name: name(result.playerId) }))
          : [],
      missedGems: state.phase === "reveal" ? state.missedGems : [],
      pearl:
        state.phase === "reveal" && prompt
          ? {
              answer: prompt.answers.find((answer) => answer.tier === "pearl")?.display ?? null,
              foundBy: state.results
                .filter((result) => result.tier === "pearl")
                .map((result) => name(result.playerId)),
            }
          : null,
      obviousPicks: state.phase === "reveal" ? state.obviousPicks : [],
      turnPlayerId: state.phase === "fuse" ? state.turnPlayerId : null,
      maxHearts: MAX_HEARTS,
      heartMeter: HEART_METER,
      seats: state.order.map((playerId) => ({
        id: playerId,
        name: name(playerId),
        lives: state.lives[playerId] ?? 0,
        meter: state.meter[playerId] ?? 0,
        out: (state.lives[playerId] ?? 0) <= 0,
      })),
      lastHeart: state.lastHeart
        ? { ...state.lastHeart, name: name(state.lastHeart.playerId) }
        : null,
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
      locked: classicLocked(entry),
      lastMiss: entry?.lastMiss ?? null,
      roundPoints: result?.points ?? 0,
      yourTurn: state.phase === "fuse" && state.turnPlayerId === playerId,
      lives: state.lives[playerId] ?? 0,
    };
  },

  isFinished: (state) => state.phase === "results",
};
