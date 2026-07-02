/**
 * Client mirror of each game's server move union.
 *
 * The SFU module is the source of truth: these unions mirror the `*Move` types
 * exported from `packages/sfu/server/games/modules/*.ts`, the same way
 * `GamePublicState` is mirrored between the server and this app. Renderers wrap
 * the SDK's game-agnostic `move` with `createTypedMove<GameMove>` so they can
 * only dispatch a move that exists in the union, with the right payload fields.
 *
 * Keep these in lockstep with the server unions. The payload fields here are the
 * exact keys the server decoders read off the wire.
 */

/** Mirrors TriviaMove in modules/trivia.ts. */
export type TriviaMove =
  | { type: "start" }
  | { type: "answer"; choice: number }
  | { type: "skip" }
  | { type: "next" };

/** Mirrors BluffMove in modules/bluff.ts. */
export type BluffMove =
  | { type: "start" }
  | { type: "submit"; text: string }
  | { type: "choose"; optionId: string }
  | { type: "next" }
  | { type: "skip" };

/** Mirrors WouldYouRatherMove in modules/wouldYouRather.ts. */
export type WouldYouRatherMove =
  | { type: "start" }
  | { type: "choose"; option: 0 | 1 }
  | { type: "next" }
  | { type: "skip" };

/** Mirrors MostLikelyToMove in modules/mostLikelyTo.ts. */
export type MostLikelyToMove =
  | { type: "start" }
  | { type: "vote"; target: string }
  | { type: "next" }
  | { type: "skip" };

/** Mirrors ReactionMove in modules/reaction.ts. */
export type ReactionMove =
  | { type: "start" }
  | { type: "tap" }
  | { type: "next" };

/** Mirrors ImposterMove in modules/imposter.ts. */
export type ImposterMove =
  | { type: "start" }
  | { type: "callVote" }
  | { type: "vote"; target: string }
  | { type: "tally" };

/** Mirrors WordleMove in modules/wordle.ts. */
export type WordleMove =
  | { type: "start" }
  | { type: "setWord"; word: string }
  | { type: "guess"; word: string }
  | { type: "nextRound" };
