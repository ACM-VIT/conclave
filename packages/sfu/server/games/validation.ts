import { GameMoveError, type GameContext } from "./types.js";

export type PlayerTargetOptions = {
  allowSelf?: boolean;
  invalidMessage?: string;
  selfMessage?: string;
};

export const payloadField = (payload: unknown, key: string): unknown =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

export const requireString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new GameMoveError(message);
  }
  return value;
};

export const requireInt = (value: unknown, message: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GameMoveError(message);
  }
  return value;
};

export const requireOneOf = <const T>(
  value: unknown,
  allowed: readonly T[],
  message: string,
): T => {
  if (!allowed.includes(value as T)) {
    throw new GameMoveError(message);
  }
  return value as T;
};

export const requirePlayerTarget = (
  ctx: GameContext,
  actorId: string,
  target: unknown,
  options: PlayerTargetOptions = {},
): string => {
  const invalidMessage = options.invalidMessage ?? "Invalid player target";
  if (
    typeof target !== "string" ||
    !ctx.players.some((player) => player.id === target)
  ) {
    throw new GameMoveError(invalidMessage);
  }
  if (options.allowSelf === false && target === actorId) {
    throw new GameMoveError(
      options.selfMessage ?? "You cannot target yourself",
    );
  }
  return target;
};
