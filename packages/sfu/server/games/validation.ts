import { GameMoveError, type GameContext } from "./types.js";

export type PlayerTargetOptions = {
  allowSelf?: boolean;
  invalidMessage?: string;
  selfMessage?: string;
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
