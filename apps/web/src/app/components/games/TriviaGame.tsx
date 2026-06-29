"use client";

import React from "react";
import { color, radius } from "@conclave/ui-tokens";
import {
  CountdownRing,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  useRemaining,
  type GameViewProps,
} from "./gameUi";

type Scoreboard = { id: string; name: string; score: number }[];

type TriviaPublic = {
  phase: "lobby" | "question" | "reveal" | "results";
  questionIndex: number;
  totalQuestions: number;
  serverNow: number;
  deadline: number | null;
  questionDurationMs: number;
  category: string | null;
  prompt: string | null;
  options: string[];
  correctIndex: number | null;
  optionCounts: number[];
  answeredCount: number;
  totalPlayers: number;
  scoreboard: Scoreboard;
};

type TriviaMe = {
  answered: boolean;
  choice: number | null;
  score: number;
  rank: number | null;
  lastRoundPoints: number;
  correct: boolean | null;
};

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];
// Kahoot-style signature colors so each answer reads as its own shape at a glance.
const OPTION_COLORS = ["#E24B4A", "#378ADD", "#EF9F27", "#639922", "#7F77DD", "#1D9E75"];

export default function TriviaGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<TriviaPublic, TriviaMe>) {
  const remaining = useRemaining(pub.deadline, pub.serverNow);

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="trivia"
        title={`${pub.totalQuestions} questions`}
        blurb="Answer fast. The quicker you lock in a correct answer, the more points you score."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        startLabel="Start quiz"
        onStart={() => move("start")}
      />
    );
  }

  if (pub.phase === "results") {
    const top = pub.scoreboard[0];
    return (
      <div style={{ padding: "4px 2px" }}>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "0 0 4px", textAlign: "center" }}>
          Final scores
        </p>
        {top ? (
          <p style={{ fontSize: 13, color: color.accent, textAlign: "center", margin: "0 0 14px" }}>
            🏆 {top.name} wins with {top.score}
          </p>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {pub.scoreboard.map((entry, index) => (
            <div
              key={entry.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: radius.md,
                background: index === 0 ? color.accentSoft : color.surfaceRaised,
              }}
            >
              <span style={{ width: 18, color: color.textFaint, fontSize: 13, fontFamily: HEAD_FONT }}>
                {index + 1}
              </span>
              <span style={{ flex: 1, color: color.text, fontSize: 14 }}>{entry.name}</span>
              <span style={{ color: color.text, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                {entry.score}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const reveal = pub.phase === "reveal";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <p style={{ fontSize: 12, color: color.accent, margin: 0, fontFamily: HEAD_FONT }}>
            {pub.category}
          </p>
          <p style={{ fontSize: 11, color: color.textFaint, margin: "2px 0 0" }}>
            Question {pub.questionIndex + 1} of {pub.totalQuestions}
          </p>
        </div>
        <CountdownRing
          remainingMs={reveal ? 0 : remaining}
          totalMs={pub.questionDurationMs}
          label={reveal ? "" : `${pub.answeredCount}/${pub.totalPlayers}`}
        />
      </div>

      <p style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, margin: 0, lineHeight: 1.35 }}>
        {pub.prompt}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pub.options.map((option, index) => {
          const isMyChoice = me.choice === index;
          const isCorrect = reveal && pub.correctIndex === index;
          const isMyWrong = reveal && isMyChoice && pub.correctIndex !== index;
          let bg: string = color.surfaceRaised;
          let bd: string = color.border;
          if (isCorrect) {
            bg = "rgba(34, 197, 94, 0.18)";
            bd = color.success;
          } else if (isMyWrong) {
            bg = color.dangerSoft;
            bd = color.danger;
          } else if (isMyChoice) {
            bg = color.accentSoft;
            bd = color.accent;
          }
          const locked = readOnly || reveal || me.answered;
          return (
            <button
              key={index}
              type="button"
              disabled={locked}
              onClick={() => move("answer", { choice: index })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                borderRadius: radius.md,
                border: `1.5px solid ${bd}`,
                background: bg,
                color: color.text,
                fontSize: 14,
                textAlign: "left",
                cursor: locked ? "default" : "pointer",
                transition: "background 150ms ease, border-color 150ms ease",
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: radius.sm,
                  background: OPTION_COLORS[index % OPTION_COLORS.length],
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: HEAD_FONT,
                  fontSize: 12,
                  fontWeight: 500,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {OPTION_LETTERS[index]}
              </span>
              <span style={{ flex: 1 }}>{option}</span>
              {reveal ? (
                <span style={{ fontSize: 12, color: color.textFaint, fontFamily: HEAD_FONT }}>
                  {pub.optionCounts[index] ?? 0}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 28 }}>
        <span style={{ fontSize: 12, color: color.textMuted }}>
          {reveal
            ? me.correct
              ? `Correct! +${me.lastRoundPoints}`
              : me.answered
                ? "Not quite"
                : "Time's up"
            : readOnly
              ? "Watching only"
              : me.answered
              ? "Locked in"
              : "Pick an answer"}
        </span>
        <span style={{ fontSize: 13, color: color.text, fontFamily: HEAD_FONT, fontWeight: 500 }}>
          {me.score} pts{me.rank ? ` · #${me.rank}` : ""}
        </span>
      </div>

      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {reveal ? (
            <GhostButton onClick={() => move("next")}>Next →</GhostButton>
          ) : (
            <GhostButton onClick={() => move("skip")}>Skip</GhostButton>
          )}
        </div>
      ) : null}
    </div>
  );
}
