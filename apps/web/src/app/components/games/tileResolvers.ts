"use client";

/**
 * Per-game tile resolvers: how each game reads its views into the shared
 * semantic PlayerTileState the SDK maps to visual primitives, plus the tile
 * actions that turn faces into live controls (tap a tile to vote). This is the
 * configurable seam. Importing this module registers everything once.
 *
 * Resolvers only read what a view genuinely exposes and never invent data.
 * Leaderboard rank is applied universally by the overlay, so resolvers only
 * cover game-specific state (acted, outcome, eliminated, selected, winner).
 */

import {
  registerTileAction,
  registerTileResolver,
  type PlayerTileState,
} from "@conclave/apps-sdk";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const voteLabel = (count: number): string =>
  count === 1 ? "1 vote" : `${count} votes`;

/** The viewer's current pick, read from their own private view. */
const yourVoteOf = (privateView: unknown): string | null => {
  const vote = asRecord(privateView)?.yourVote;
  return typeof vote === "string" ? vote : null;
};

/* ---- Trivia: server projects a per-player tiles map (acted / outcome). ---- */

type TriviaTile = {
  acted?: boolean;
  outcome?: "correct" | "wrong";
  note?: string;
};

registerTileResolver("trivia", ({ publicView, playerId }): PlayerTileState | null => {
  const tiles = asRecord(asRecord(publicView)?.tiles);
  const mine = tiles ? (tiles[playerId] as TriviaTile | undefined) : undefined;
  if (!mine) return null;
  const state: PlayerTileState = {};
  if (mine.acted) state.acted = true;
  if (mine.outcome) state.outcome = mine.outcome;
  if (mine.note) state.note = mine.note;
  return Object.keys(state).length > 0 ? state : null;
});

/* ---- Reaction: reveal results carry an early (too soon) flag. ---- */

type ReactionResult = { id: string; early?: boolean };

registerTileResolver("reaction", ({ publicView, playerId }): PlayerTileState | null => {
  const results = asRecord(publicView)?.results;
  if (!Array.isArray(results)) return null;
  const mine = (results as ReactionResult[]).find((r) => r.id === playerId);
  if (mine?.early) return { eliminated: true, note: "Too soon" };
  return null;
});

/* ---- Imposter: live vote state, tap to accuse, and the unmask beat. ---- */

registerTileResolver(
  "imposter",
  ({ publicView, privateView, playerId }): PlayerTileState | null => {
    const view = asRecord(publicView);
    if (!view) return null;
    const phase = view.phase;

    if (phase === "vote") {
      const state: PlayerTileState = {};
      if (stringArray(view.votedPlayerIds).includes(playerId)) state.acted = true;
      const counts = asRecord(view.voteCounts);
      const count = counts && typeof counts[playerId] === "number" ? (counts[playerId]) : 0;
      if (count > 0) state.note = voteLabel(count);
      if (yourVoteOf(privateView) === playerId) state.selected = true;
      return Object.keys(state).length > 0 ? state : null;
    }

    if (phase === "result") {
      const result = asRecord(view.result);
      if (!result) return null;
      const imposterId = typeof result.imposterId === "string" ? result.imposterId : null;
      const votedOutId = typeof result.votedOutId === "string" ? result.votedOutId : null;
      if (imposterId === playerId) {
        // The unmask lands on the imposter's face: dimmed and skulled when the
        // crew caught them, crowned when they escaped the vote.
        return votedOutId === playerId
          ? { eliminated: true, note: "Imposter" }
          : { winner: true, note: "Imposter" };
      }
      if (votedOutId === playerId) {
        return { eliminated: true, note: "Voted out" };
      }
      return null;
    }

    return null;
  },
);

registerTileAction("imposter", ({ publicView, playerId, viewerId }) => {
  const view = asRecord(publicView);
  if (!view || view.phase !== "vote") return null;
  if (!viewerId || playerId === viewerId) return null;
  return { type: "vote", payload: { target: playerId }, label: "Vote" };
});

/* ---- Most likely to: tap any face to vote (self included), crown the pick. ---- */

registerTileResolver(
  "most-likely-to",
  ({ publicView, privateView, playerId }): PlayerTileState | null => {
    const view = asRecord(publicView);
    if (!view) return null;
    const phase = view.phase;

    if (phase === "vote") {
      const state: PlayerTileState = {};
      if (stringArray(view.votedPlayerIds).includes(playerId)) state.acted = true;
      if (yourVoteOf(privateView) === playerId) state.selected = true;
      return Object.keys(state).length > 0 ? state : null;
    }

    if (phase === "reveal") {
      const winnerId = typeof view.winnerId === "string" ? view.winnerId : null;
      if (winnerId !== playerId) return null;
      const counts = asRecord(view.counts);
      const count = counts && typeof counts[playerId] === "number" ? (counts[playerId]) : 0;
      return { winner: true, note: count > 0 ? voteLabel(count) : undefined };
    }

    return null;
  },
);

registerTileAction("most-likely-to", ({ publicView, playerId, viewerId }) => {
  const view = asRecord(publicView);
  if (!view || view.phase !== "vote") return null;
  if (!viewerId) return null;
  // Self-votes are allowed in this game, so every tile is a valid ballot.
  return { type: "vote", payload: { target: playerId }, label: "Vote" };
});
