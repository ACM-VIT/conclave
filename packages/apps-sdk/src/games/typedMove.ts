/**
 * Typed move dispatch for game renderers.
 *
 * The SDK's underlying `move(type, payload)` stays game-agnostic (it just puts a
 * type + payload on the wire). Each game mirrors its server move union on the
 * client, then wraps `move` with `createTypedMove<TheGameMove>` so a renderer
 * can only send well-formed, correctly-named moves.
 *
 * The wire payload is kept byte-identical to today's hand-written calls: the
 * `type` is passed as the event type and the remaining fields become the
 * payload, so `send({ type: "answer", choice })` emits exactly the same
 * `{ choice }` payload the renderer used to send with `move("answer", { choice })`.
 * A payload-less move like `{ type: "start" }` emits an undefined payload,
 * matching `move("start")`.
 */

import type { GameMoveResult } from "./types";

/** Any typed move is a discriminated union member keyed by a string `type`. */
export type TypedGameMove = { type: string };

export type SendTypedMove<M extends TypedGameMove> = (
  move: M,
) => Promise<GameMoveResult>;

/**
 * Wrap the game-agnostic `move(type, payload)` so a renderer dispatches typed
 * moves: `send({ type: "answer", choice })`. Splits the discriminant off the
 * payload so the wire shape stays `{ choice }`, `{ text }`, `{ optionId }`, and
 * a fields-only move sends no payload at all.
 */
export const createTypedMove = <M extends TypedGameMove>(
  move: (type: string, payload?: unknown) => Promise<GameMoveResult>,
): SendTypedMove<M> => (typedMove: M) => {
  const { type, ...payload } = typedMove;
  return move(type, Object.keys(payload).length > 0 ? payload : undefined);
};
