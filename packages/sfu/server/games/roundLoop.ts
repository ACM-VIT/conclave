import type { GameContext } from "./types.js";

/**
 * Shared round/phase/liveness machinery for the round-based party games.
 *
 * Several games (would-you-rather, most-likely-to, bluff, ...) hand-roll the
 * same shape: N rounds, each round runs one or more collect phases that gather
 * one action per player, then a reveal, then either the next round or results.
 * A collect phase must advance EARLY the moment every player who is still
 * present has acted, otherwise it rides its deadline via onTick.
 *
 * The subtle, correctness-critical rule that lived (and once broke) in every
 * copy is which player set the "everyone has acted" gate is measured against:
 * it must be `ctx.activePlayers` (currently-connected seat holders), NOT
 * `ctx.players` (frozen seats). A disconnected seat holder must not make the
 * room wait out the full timer every round. Centralizing that gate here makes
 * it impossible for a game to reintroduce the disconnect bug by reaching for
 * the wrong player set.
 */

/**
 * The liveness gate. Returns true only when at least one player is currently
 * present AND every present player has acted. `hasActed` is asked per active
 * player id, so callers never have to know about the players vs activePlayers
 * distinction themselves.
 */
export const allActivePlayersActed = (
  ctx: GameContext,
  hasActed: (playerId: string) => boolean,
): boolean =>
  ctx.activePlayers.length > 0 &&
  ctx.activePlayers.every((player) => hasActed(player.id));

/**
 * A collect phase gathers one action per present player behind a deadline.
 *
 *  - `name`      is the phase label as it appears in the module's own state.
 *  - `hasActed`  answers, for a given state and player id, whether that player
 *                has already acted this phase (their pick/vote/answer is in).
 *  - `onEnter`   builds the state that begins this phase: it sets the module's
 *                phase label, clears the round-scoped buffers this phase fills,
 *                and stamps `deadline`. It is the ONLY place a phase's deadline
 *                is established, so the phase owns its own duration.
 */
export type CollectPhase<S> = {
  name: string;
  hasActed: (state: S, playerId: string) => boolean;
  onEnter: (state: S, ctx: GameContext) => S;
};

/**
 * The reveal phase shows the round result.
 *
 *  - `name`      is the reveal phase label in the module's state.
 *  - `onEnter`   builds the reveal state from the last collect phase: it flips
 *                the phase label, runs any round scoring, and stamps the reveal
 *                deadline. Stamping `now + duration` makes reveal auto-advance
 *                when that deadline passes (a timed reveal); stamping 0 makes it
 *                sticky, advancing only when the host collapses the deadline via
 *                a "next" move (a manual reveal).
 */
type RevealPhase<S> = {
  name: string;
  onEnter: (state: S, ctx: GameContext) => S;
};

export type RoundLoopSpec<S> = {
  /** Reads the module's current phase label off its state. */
  getPhase: (state: S) => string;
  /** Reads the deadline the loop drives its transitions against. */
  getDeadline: (state: S) => number;
  /** Stamps a new deadline (used when a collect phase collapses early). */
  withDeadline: (state: S, deadline: number) => S;
  /** The ordered collect phases within a single round. */
  collectPhases: CollectPhase<S>[];
  /** The reveal phase that closes out a round. */
  reveal: RevealPhase<S>;
  /** True when the round that just revealed is the final round. */
  isLastRound: (state: S) => boolean;
  /** Builds the state that begins the next round's first collect phase. */
  startNextRound: (state: S, ctx: GameContext) => S;
  /** Builds the terminal results state. */
  toResults: (state: S) => S;
};

/**
 * Drives one round loop. A module keeps its own state shape and phase labels
 * and delegates the two moving parts to this helper:
 *
 *   - `recordAction(state, ctx)`: call from a collect move AFTER folding the new
 *     action into `state`. It collapses the phase deadline to now when every
 *     present player has acted, otherwise leaves the deadline untouched. The
 *     phase is inferred from the state, so a module with several collect phases
 *     does not branch on which one it is in.
 *
 *   - `tick(state, ctx)`: the whole `onTick` state machine. Advances a collect
 *     phase to the next collect phase (or to reveal) when its deadline passes,
 *     and advances reveal to the next round (or to results). Returns the state
 *     unchanged when nothing is due.
 */
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
