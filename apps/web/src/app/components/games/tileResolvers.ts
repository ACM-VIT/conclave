"use client";

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

const yourVoteOf = (privateView: unknown): string | null => {
  const vote = asRecord(privateView)?.yourVote;
  return typeof vote === "string" ? vote : null;
};

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

type ReactionResult = { id: string; early?: boolean };

registerTileResolver("reaction", ({ publicView, playerId }): PlayerTileState | null => {
  const results = asRecord(publicView)?.results;
  if (!Array.isArray(results)) return null;
  const mine = (results as ReactionResult[]).find((r) => r.id === playerId);
  if (mine?.early) return { eliminated: true, note: "Too soon" };
  return null;
});

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
  return { type: "vote", payload: { target: playerId }, label: "Vote" };
});

type LongShotTile = {
  acted?: boolean;
  outcome?: "correct" | "wrong";
  note?: string;
  active?: boolean;
  eliminated?: boolean;
  winner?: boolean;
};

registerTileResolver("long-shot", ({ publicView, playerId }): PlayerTileState | null => {
  const tiles = asRecord(asRecord(publicView)?.tiles);
  const mine = tiles ? (tiles[playerId] as LongShotTile | undefined) : undefined;
  if (!mine) return null;
  const state: PlayerTileState = {};
  if (mine.acted) state.acted = true;
  if (mine.outcome) state.outcome = mine.outcome;
  if (mine.active) state.active = true;
  if (mine.eliminated) state.eliminated = true;
  if (mine.winner) state.winner = true;
  if (mine.note) state.note = mine.note;
  return Object.keys(state).length > 0 ? state : null;
});
