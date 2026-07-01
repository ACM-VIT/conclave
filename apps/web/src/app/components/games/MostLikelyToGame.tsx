"use client";

import React from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import {
  Avatar,
  CountdownRing,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  useRemaining,
  type GameViewProps,
} from "./gameUi";
import type { MostLikelyToMove } from "./moves";

type MltPlayer = { id: string; name: string };

type MltPublic = {
  phase: "lobby" | "vote" | "reveal" | "results";
  index: number;
  total: number;
  serverNow: number;
  deadline: number | null;
  voteDurationMs: number;
  prompt: string | null;
  players: MltPlayer[];
  counts: Record<string, number>;
  answeredCount: number;
  totalPlayers: number;
  winnerId: string | null;
  winnerName: string | null;
};

type MltMe = { yourVote: string | null };

export default function MostLikelyToGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<MltPublic, MltMe>) {
  const send = createTypedMove<MostLikelyToMove>(move);
  const remaining = useRemaining(pub.deadline, pub.serverNow);

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="most-likely-to"
        title="Point the finger"
        blurb="Each round, vote on who fits the prompt. The room decides who gets crowned."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={pub.totalPlayers >= 3}
        disabledLabel="Need at least 3 players"
        onStart={() => send({ type: "start" })}
      />
    );
  }

  if (pub.phase === "results") {
    return (
      <div style={{ textAlign: "center", padding: "20px 4px" }}>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: 0 }}>
          That is a wrap
        </p>
        <p style={{ fontSize: 13, color: color.textMuted, margin: "8px 0 0" }}>
          No hard feelings, right?
        </p>
      </div>
    );
  }

  const reveal = pub.phase === "reveal";
  const maxCount = Math.max(1, ...Object.values(pub.counts));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ fontSize: 11, color: color.textFaint, margin: 0 }}>
          Round {pub.index + 1} of {pub.total}
        </p>
        {!reveal && pub.deadline ? (
          <CountdownRing
            remainingMs={remaining}
            totalMs={pub.voteDurationMs}
            label={`${pub.answeredCount}/${pub.totalPlayers}`}
          />
        ) : null}
      </div>

      <div style={{ textAlign: "center" }}>
        <span style={{ fontSize: 13, color: color.textMuted }}>Who is most likely</span>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 19, color: color.text, margin: "4px 0 0", lineHeight: 1.3 }}>
          {pub.prompt}?
        </p>
      </div>

      {reveal && pub.winnerName ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: radius.md,
            background: color.accentSoft,
            border: `1.5px solid ${color.accent}`,
          }}
        >
          <Avatar name={pub.winnerName} size={32} highlight />
          <span style={{ fontFamily: HEAD_FONT, fontSize: 15, color: color.text }}>
            {pub.winnerName}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: color.accent }}>
            the room has spoken
          </span>
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pub.players.map((player) => {
          const isMyVote = me.yourVote === player.id;
          const voteCount = pub.counts[player.id] ?? 0;
          const isWinner = reveal && player.id === pub.winnerId;
          return (
            <button
              key={player.id}
              type="button"
              disabled={readOnly || reveal || me.yourVote !== null}
              onClick={() => send({ type: "vote", target: player.id })}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: radius.md,
                border: `1.5px solid ${isMyVote || isWinner ? color.accent : color.border}`,
                background: color.surfaceRaised,
                color: color.text,
                cursor:
                  readOnly || reveal || me.yourVote !== null
                    ? "default"
                    : "pointer",
                overflow: "hidden",
              }}
            >
              {reveal ? (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${(voteCount / maxCount) * 100}%`,
                    background: color.accentSoft,
                  }}
                />
              ) : null}
              <Avatar name={player.name} size={30} highlight={isMyVote} />
              <span style={{ flex: 1, textAlign: "left", fontSize: 14, zIndex: 1 }}>
                {player.name}
                {player.id === userId ? " (you)" : ""}
              </span>
              {reveal && voteCount > 0 ? (
                <span style={{ fontSize: 12, color: color.textMuted, fontFamily: HEAD_FONT, zIndex: 1 }}>
                  {voteCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {reveal ? (
            <GhostButton onClick={() => send({ type: "next" })}>Next</GhostButton>
          ) : (
            <GhostButton onClick={() => send({ type: "skip" })}>Reveal</GhostButton>
          )}
        </div>
      ) : null}
    </div>
  );
}
