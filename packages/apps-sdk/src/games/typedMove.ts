import type { GameMoveResult } from "./types";

export type TypedGameMove = { type: string };

export type SendTypedMove<M extends TypedGameMove> = (
  move: M,
) => Promise<GameMoveResult>;

export const createTypedMove = <M extends TypedGameMove>(
  move: (type: string, payload?: unknown) => Promise<GameMoveResult>,
): SendTypedMove<M> => (typedMove: M) => {
  const { type, ...payload } = typedMove;
  return move(type, Object.keys(payload).length > 0 ? payload : undefined);
};
