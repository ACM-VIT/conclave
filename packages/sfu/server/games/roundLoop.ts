import type { GameContext } from "./types.js";

export const allActivePlayersActed = (
  ctx: GameContext,
  hasActed: (playerId: string) => boolean,
): boolean =>
  ctx.activePlayers.length > 0 &&
  ctx.activePlayers.every((player) => hasActed(player.id));

export type CollectPhase<S> = {
  name: string;
  hasActed: (state: S, playerId: string) => boolean;
  onEnter: (state: S, ctx: GameContext) => S;
};

type RevealPhase<S> = {
  name: string;
  onEnter: (state: S, ctx: GameContext) => S;
};

export type RoundLoopSpec<S> = {
  getPhase: (state: S) => string;
  getDeadline: (state: S) => number;
  withDeadline: (state: S, deadline: number) => S;
  collectPhases: CollectPhase<S>[];
  reveal: RevealPhase<S>;
  isLastRound: (state: S) => boolean;
  startNextRound: (state: S, ctx: GameContext) => S;
  toResults: (state: S) => S;
};

export const createRoundLoop = <S>(spec: RoundLoopSpec<S>) => {
  const collectPhaseByName = new Map<string, CollectPhase<S>>();
  for (const phase of spec.collectPhases) {
    collectPhaseByName.set(phase.name, phase);
  }

  const recordAction = (state: S, ctx: GameContext): S => {
    const phase = collectPhaseByName.get(spec.getPhase(state));
    if (!phase) return state;
    const everyone = allActivePlayersActed(ctx, (playerId) =>
      phase.hasActed(state, playerId),
    );
    return everyone ? spec.withDeadline(state, ctx.now) : state;
  };

  const tick = (state: S, ctx: GameContext): S => {
    const phaseName = spec.getPhase(state);

    const collectIndex = spec.collectPhases.findIndex(
      (phase) => phase.name === phaseName,
    );
    if (collectIndex >= 0) {
      if (ctx.now < spec.getDeadline(state)) return state;
      const next = spec.collectPhases[collectIndex + 1];
      return next ? next.onEnter(state, ctx) : spec.reveal.onEnter(state, ctx);
    }

    if (phaseName === spec.reveal.name) {
      const deadline = spec.getDeadline(state);
      if (ctx.now < deadline || deadline <= 0) return state;
      if (spec.isLastRound(state)) return spec.toResults(state);
      return spec.startNextRound(state, ctx);
    }

    return state;
  };

  return { recordAction, tick };
};
