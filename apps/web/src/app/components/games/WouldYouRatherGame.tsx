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

type WyrPublic = {
  phase: "lobby" | "choose" | "reveal" | "results";
  index: number;
  total: number;
  serverNow: number;
  deadline: number | null;
  chooseDurationMs: number;
  optionA: string | null;
  optionB: string | null;
  counts: [number, number];
  answeredCount: number;
  totalPlayers: number;
  namesA: string[];
  namesB: string[];
};

type WyrMe = { choice: 0 | 1 | null };

function OptionCard({
  text,
  picked,
  accent,
  onClick,
  disabled,
}: {
  text: string;
  picked: boolean;
  accent: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: 96,
        padding: "16px 14px",
        borderRadius: radius.lg,
        border: `2px solid ${picked ? accent : color.border}`,
        background: picked ? `${accent}26` : color.surfaceRaised,
        color: color.text,
        fontFamily: HEAD_FONT,
        fontSize: 16,
        fontWeight: 500,
        lineHeight: 1.3,
        cursor: disabled ? "default" : "pointer",
        transition: "border-color 150ms ease, background 150ms ease",
      }}
    >
      {text}
    </button>
  );
}

export default function WouldYouRatherGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<WyrPublic, WyrMe>) {
  const remaining = useRemaining(pub.deadline, pub.serverNow);

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="would-you-rather"
        title={`${pub.total} rounds, no wrong answers`}
        blurb="Pick a side each round, then watch the room split and argue about it."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        onStart={() => move("start")}
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
          Nice picks. Run it back any time.
        </p>
      </div>
    );
  }

  const reveal = pub.phase === "reveal";
  const [a, b] = pub.counts;
  const total = Math.max(1, a + b);
  const accentA = color.accent;
  const accentB = color.accentSecondary;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ fontSize: 11, color: color.textFaint, margin: 0 }}>
          Round {pub.index + 1} of {pub.total}
        </p>
        {!reveal && pub.deadline ? (
          <CountdownRing
            remainingMs={remaining}
            totalMs={pub.chooseDurationMs}
            label={`${pub.answeredCount}/${pub.totalPlayers}`}
          />
        ) : null}
      </div>

      <p style={{ fontFamily: HEAD_FONT, fontSize: 15, color: color.textMuted, margin: 0, textAlign: "center" }}>
        Would you rather
      </p>

      <div style={{ display: "flex", gap: 10 }}>
        <OptionCard
          text={pub.optionA ?? ""}
          picked={me.choice === 0}
          accent={accentA}
          disabled={readOnly || reveal || me.choice !== null}
          onClick={() => move("choose", { option: 0 })}
        />
        <OptionCard
          text={pub.optionB ?? ""}
          picked={me.choice === 1}
          accent={accentB}
          disabled={readOnly || reveal || me.choice !== null}
          onClick={() => move("choose", { option: 1 })}
        />
      </div>

      {reveal ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", height: 12, borderRadius: radius.pill, overflow: "hidden", background: color.surfaceRaised }}>
            <div style={{ width: `${(a / total) * 100}%`, background: accentA }} />
            <div style={{ width: `${(b / total) * 100}%`, background: accentB }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <p style={{ fontFamily: HEAD_FONT, color: accentA, fontSize: 14, margin: 0 }}>{a} picked</p>
              <p style={{ fontSize: 12, color: color.textMuted, margin: "2px 0 0", lineHeight: 1.5 }}>
                {pub.namesA.join(", ") || "nobody"}
              </p>
            </div>
            <div style={{ flex: 1, textAlign: "right" }}>
              <p style={{ fontFamily: HEAD_FONT, color: accentB, fontSize: 14, margin: 0 }}>{b} picked</p>
              <p style={{ fontSize: 12, color: color.textMuted, margin: "2px 0 0", lineHeight: 1.5 }}>
                {pub.namesB.join(", ") || "nobody"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: color.textMuted, textAlign: "center", margin: 0 }}>
          {readOnly
            ? "Watching only"
            : me.choice !== null
              ? "Locked in"
              : "Pick a side"}
        </p>
      )}

      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {reveal ? (
            <GhostButton onClick={() => move("next")}>Next</GhostButton>
          ) : (
            <GhostButton onClick={() => move("skip")}>Reveal</GhostButton>
          )}
        </div>
      ) : null}
    </div>
  );
}
