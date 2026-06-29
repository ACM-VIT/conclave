"use client";

import React from "react";
import { color, radius } from "@conclave/ui-tokens";
import {
  Avatar,
  CountdownRing,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
  useRemaining,
  type GameViewProps,
} from "./gameUi";

type ImposterPlayer = { id: string; name: string };

type ImposterResult = {
  imposterId: string;
  imposterName: string | null;
  word: string;
  votedOutId: string | null;
  votedOutName: string | null;
  crewWon: boolean;
  tie: boolean;
};

type ImposterPublic = {
  phase: "lobby" | "reveal" | "discuss" | "vote" | "result";
  category: string;
  serverNow: number;
  deadline: number | null;
  starterName: string | null;
  players: ImposterPlayer[];
  votedPlayerIds: string[];
  voteCounts: Record<string, number>;
  totalPlayers: number;
  result: ImposterResult | null;
};

type ImposterMe = {
  role: "imposter" | "crew";
  category: string;
  word: string | null;
  hint: string | null;
  yourVote: string | null;
};

function SecretCard({ me, compact }: { me: ImposterMe; compact?: boolean }) {
  const isImposter = me.role === "imposter";
  return (
    <div
      style={{
        borderRadius: radius.lg,
        padding: compact ? "12px 14px" : "22px 18px",
        textAlign: "center",
        background: isImposter ? color.dangerSoft : color.accentSoft,
        border: `1.5px solid ${isImposter ? color.danger : color.accent}`,
      }}
    >
      <p style={{ fontSize: 12, color: color.textMuted, margin: 0, fontFamily: HEAD_FONT }}>
        {me.category}
      </p>
      {isImposter ? (
        <>
          <p style={{ fontFamily: HEAD_FONT, fontSize: compact ? 18 : 24, fontWeight: 500, color: color.danger, margin: "8px 0 0" }}>
            You're the imposter
          </p>
          {!compact && me.hint ? (
            <p style={{ fontSize: 13, color: color.textMuted, margin: "8px 0 0" }}>{me.hint}</p>
          ) : null}
        </>
      ) : (
        <p style={{ fontFamily: HEAD_FONT, fontSize: compact ? 18 : 28, fontWeight: 500, color: color.text, margin: "8px 0 0" }}>
          {me.word}
        </p>
      )}
    </div>
  );
}

export default function ImposterGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<ImposterPublic, ImposterMe>) {
  const remaining = useRemaining(pub.deadline, pub.serverNow);

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="imposter"
        title="One of you is faking it"
        blurb="Everyone gets a secret word except the imposter. Describe it out loud on camera, then vote on who is bluffing."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={pub.totalPlayers >= 3}
        startLabel="Deal secret words"
        disabledLabel="Need at least 3 players"
        onStart={() => move("start")}
      />
    );
  }

  if (pub.phase === "reveal") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "8px 0" }}>
        <SecretCard me={me} />
        <CountdownRing remainingMs={remaining} totalMs={6000} label="discuss" />
        <p style={{ fontSize: 12, color: color.textFaint, margin: 0 }}>Memorize your card</p>
      </div>
    );
  }

  if (pub.phase === "result" && pub.result) {
    const r = pub.result;
    const banner = r.tie
      ? { text: "Tie, the imposter survives", c: color.warning }
      : r.crewWon
        ? { text: "Crew wins! Imposter caught", c: color.success }
        : { text: "Imposter escapes!", c: color.danger };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 2px" }}>
        <div
          style={{
            borderRadius: radius.md,
            padding: "12px 14px",
            textAlign: "center",
            background: color.surfaceRaised,
            border: `1.5px solid ${banner.c}`,
            color: banner.c,
            fontFamily: HEAD_FONT,
            fontSize: 15,
            fontWeight: 500,
          }}
        >
          {banner.text}
        </div>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 12, color: color.textMuted, margin: 0 }}>The imposter was</p>
          <p style={{ fontFamily: HEAD_FONT, fontSize: 20, color: color.text, margin: "4px 0" }}>
            {r.imposterName ?? "?"}
          </p>
          <p style={{ fontSize: 13, color: color.textMuted, margin: 0 }}>
            The secret word was <span style={{ color: color.accent }}>{r.word}</span>
          </p>
        </div>
      </div>
    );
  }

  // discuss + vote
  const voting = pub.phase === "vote";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SecretCard me={me} compact />

      {pub.phase === "discuss" ? (
        <p style={{ fontSize: 13, color: color.textMuted, margin: 0, textAlign: "center", lineHeight: 1.5 }}>
          {pub.starterName ? <><b style={{ color: color.text }}>{pub.starterName}</b> starts. </> : null}
          Take turns describing the word, but stay vague. Don&apos;t give it away.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: color.textMuted, margin: 0, textAlign: "center" }}>
          Who&apos;s the imposter? {pub.votedPlayerIds.length}/{pub.totalPlayers} voted.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pub.players.map((player) => {
          const isMe = player.id === userId;
          const isMyVote = me.yourVote === player.id;
          const voteCount = pub.voteCounts[player.id] ?? 0;
          return (
            <button
              key={player.id}
              type="button"
              disabled={readOnly || !voting || isMe}
              onClick={() => move("vote", { target: player.id })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: radius.md,
                border: `1.5px solid ${isMyVote ? color.accent : color.border}`,
                background: isMyVote ? color.accentSoft : color.surfaceRaised,
                color: color.text,
                cursor: !readOnly && voting && !isMe ? "pointer" : "default",
                opacity: isMe && voting ? 0.55 : 1,
              }}
            >
              <Avatar name={player.name} size={30} highlight={isMyVote} />
              <span style={{ flex: 1, textAlign: "left", fontSize: 14 }}>
                {player.name}
                {isMe ? " (you)" : ""}
              </span>
              {voting && voteCount > 0 ? (
                <span style={{ fontSize: 12, color: color.textFaint, fontFamily: HEAD_FONT }}>
                  {voteCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {pub.phase === "discuss" ? (
            <PrimaryButton onClick={() => move("callVote")}>Call vote</PrimaryButton>
          ) : (
            <GhostButton onClick={() => move("tally")}>End vote</GhostButton>
          )}
        </div>
      ) : null}
    </div>
  );
}
