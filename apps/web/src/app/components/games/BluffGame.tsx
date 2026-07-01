"use client";

import React, { useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import {
  CountdownRing,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
  useRemaining,
  type GameViewProps,
} from "./gameUi";
import type { BluffMove } from "./moves";

type ChooseOption = { id: string; text: string };
type RevealOption = {
  id: string;
  text: string;
  kind: "real" | "fake";
  ownerName: string | null;
  votes: number;
};

type BluffPublic = {
  phase: "lobby" | "write" | "choose" | "reveal" | "results";
  round: number;
  totalRounds: number;
  serverNow: number;
  deadline: number | null;
  question: string | null;
  submittedCount: number;
  chosenCount: number;
  totalPlayers: number;
  options: (ChooseOption | RevealOption)[];
  roundPoints: { id: string; name: string; points: number }[];
  scoreboard: { id: string; name: string; score: number }[];
};

type BluffMe = {
  yourFake: string | null;
  submitted: boolean;
  yourPick: string | null;
  ownOptionId: string | null;
  score: number;
};

const Question = ({ text }: { text: string }) => (
  <div
    style={{
      borderRadius: radius.md,
      background: color.surfaceRaised,
      border: `1px solid ${color.border}`,
      padding: "12px 14px",
    }}
  >
    <p style={{ fontFamily: HEAD_FONT, fontSize: 15, color: color.text, margin: 0, lineHeight: 1.4 }}>
      {text}
    </p>
  </div>
);

export default function BluffGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<BluffPublic, BluffMe>) {
  const send = createTypedMove<BluffMove>(move);
  const remaining = useRemaining(pub.deadline, pub.serverNow);
  const [draft, setDraft] = useState("");

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="bluff"
        title="Write a convincing lie"
        blurb="Everyone invents a fake answer to a real prompt, then tries to spot the truth among the bluffs. Fool people for points."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={pub.totalPlayers >= 2}
        disabledLabel="Need at least 2 players"
        onStart={() => send({ type: "start" })}
      />
    );
  }

  if (pub.phase === "results") {
    const top = pub.scoreboard[0];
    return (
      <div>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "0 0 4px", textAlign: "center" }}>
          Best bluffer
        </p>
        {top ? (
          <p style={{ fontSize: 13, color: color.accent, textAlign: "center", margin: "0 0 14px" }}>
            {top.name} wins with {top.score}
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
              <span style={{ width: 18, color: color.textFaint, fontSize: 13, fontFamily: HEAD_FONT }}>{index + 1}</span>
              <span style={{ flex: 1, color: color.text, fontSize: 14 }}>{entry.name}</span>
              <span style={{ color: color.text, fontFamily: HEAD_FONT, fontWeight: 500 }}>{entry.score}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <p style={{ fontSize: 11, color: color.textFaint, margin: 0 }}>
        Round {pub.round + 1} of {pub.totalRounds}
      </p>
      {pub.deadline ? (
        <CountdownRing
          remainingMs={remaining}
          totalMs={pub.phase === "write" ? 40000 : 30000}
          label={pub.phase === "write" ? `${pub.submittedCount}/${pub.totalPlayers}` : `${pub.chosenCount}/${pub.totalPlayers}`}
        />
      ) : null}
    </div>
  );

  if (pub.phase === "write") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Question text={pub.question ?? ""} />
        {me.submitted ? (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <p style={{ fontSize: 13, color: color.textMuted, margin: 0 }}>Your bluff</p>
            <p style={{ fontFamily: HEAD_FONT, fontSize: 16, color: color.accent, margin: "6px 0 0" }}>
              {me.yourFake}
            </p>
            <p style={{ fontSize: 12, color: color.textFaint, margin: "10px 0 0" }}>
              Waiting for everyone. {pub.submittedCount}/{pub.totalPlayers} in.
            </p>
          </div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 60))}
              disabled={readOnly}
              placeholder="Make up a believable answer"
              rows={2}
              style={{
                width: "100%",
                resize: "none",
                borderRadius: radius.md,
                border: `1.5px solid ${color.border}`,
                background: color.surface,
                color: color.text,
                padding: "10px 12px",
                fontSize: 14,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: color.textFaint }}>{draft.length}/60</span>
              <PrimaryButton
                disabled={readOnly || !draft.trim()}
                onClick={() => send({ type: "submit", text: draft.trim() })}
              >
                Submit bluff
              </PrimaryButton>
            </div>
          </>
        )}
        {isAdmin && !readOnly ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <GhostButton onClick={() => send({ type: "skip" })}>Skip</GhostButton>
          </div>
        ) : null}
      </div>
    );
  }

  if (pub.phase === "choose") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Question text={pub.question ?? ""} />
        <p style={{ fontSize: 12, color: color.textMuted, margin: 0, textAlign: "center" }}>
          Which one is the truth?
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(pub.options as ChooseOption[]).map((option) => {
            const isOwn = me.ownOptionId === option.id;
            const isMyPick = me.yourPick === option.id;
            const locked = readOnly || isOwn || me.yourPick !== null;
            return (
              <button
                key={option.id}
                type="button"
                disabled={locked}
                onClick={() => send({ type: "choose", optionId: option.id })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 14px",
                  borderRadius: radius.md,
                  border: `1.5px solid ${isMyPick ? color.accent : color.border}`,
                  background: isMyPick ? color.accentSoft : color.surfaceRaised,
                  color: color.text,
                  fontSize: 14,
                  textAlign: "left",
                  cursor: locked ? "default" : "pointer",
                  opacity: isOwn ? 0.5 : 1,
                }}
              >
                <span style={{ flex: 1 }}>{option.text}</span>
                {isOwn ? (
                  <span style={{ fontSize: 11, color: color.textFaint }}>your bluff</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {isAdmin && !readOnly ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <GhostButton onClick={() => send({ type: "skip" })}>Reveal</GhostButton>
          </div>
        ) : null}
      </div>
    );
  }

  // reveal
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 11, color: color.textFaint, margin: 0 }}>
        Round {pub.round + 1} of {pub.totalRounds}
      </p>
      <Question text={pub.question ?? ""} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(pub.options as RevealOption[]).map((option) => {
          const real = option.kind === "real";
          const isMyPick = me.yourPick === option.id;
          return (
            <div
              key={option.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                borderRadius: radius.md,
                border: `1.5px solid ${real ? color.success : isMyPick ? color.accent : color.border}`,
                background: real ? "rgba(34,197,94,0.14)" : color.surfaceRaised,
              }}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 14, color: color.text }}>{option.text}</span>
                <div style={{ fontSize: 11, color: real ? color.success : color.textFaint, marginTop: 2 }}>
                  {real ? "The truth" : `Bluff by ${option.ownerName ?? "someone"}`}
                  {isMyPick ? " · you picked this" : ""}
                </div>
              </div>
              <span style={{ fontSize: 12, color: color.textMuted, fontFamily: HEAD_FONT }}>
                {option.votes}
              </span>
            </div>
          );
        })}
      </div>
      {pub.roundPoints.length > 0 ? (
        <p style={{ fontSize: 12, color: color.textMuted, margin: 0, lineHeight: 1.6 }}>
          {pub.roundPoints.map((r) => `${r.name} +${r.points}`).join(" · ")}
        </p>
      ) : null}
      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <GhostButton onClick={() => send({ type: "next" })}>Next</GhostButton>
        </div>
      ) : null}
    </div>
  );
}
