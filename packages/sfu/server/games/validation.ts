import { GameMoveError, type GameContext } from "./types.js";

export type PlayerTargetOptions = {
  allowSelf?: boolean;
  invalidMessage?: string;
  selfMessage?: string;
};

/**
 * Read a single field off an untrusted move payload without asserting its type.
 * Modules build their typed move unions on top of this by validating the field
 * with the decoders below.
 */
export const payloadField = (payload: unknown, key: string): unknown =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

/** Decode a required non-empty string, throwing `message` on anything else. */
export const requireString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new GameMoveError(message);
  }
  return value;
};

/** Decode a required integer, throwing `message` on anything else. */
export const requireInt = (value: unknown, message: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GameMoveError(message);
  }
  return value;
};

/**
 * Decode a value that must be one of a fixed set of allowed literals. Used for
 * small enum-like payload fields (e.g. a would-you-rather side of 0 or 1).
 */
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

/**
 * Shared server-side validator for moves that target another player.
 * Game modules own their rules, but they should not have to reimplement the
 * same payload/type/self-target checks for every vote, challenge, or pick.
 */
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
