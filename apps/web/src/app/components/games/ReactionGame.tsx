"use client";

import React, { useEffect, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { GameLobby, GhostButton, HEAD_FONT, type GameViewProps } from "./gameUi";

type ReactionResult = { id: string; name: string; reactionMs: number | null; early: boolean };

type ReactionPublic = {
  phase: "lobby" | "arming" | "go" | "reveal" | "results";
  round: number;
  totalRounds: number;
  serverNow: number;
  goAt: number | null;
  tappedCount: number;
  totalPlayers: number;
  results: ReactionResult[];
  winnerName: string | null;
  scoreboard: { id: string; name: string; score: number }[];
};

type ReactionMe = {
  tapped: boolean;
  early: boolean;
  reactionMs: number | null;
  score: number;
};

/** Counts UP from the server go moment, skew-free. */
function useElapsed(goAt: number | null, serverNow: number | null): number {
  const [ms, setMs] = useState(0);
  const baseRef = useRef({ goAt, serverNow, at: Date.now() });
  useEffect(() => {
    baseRef.current = { goAt, serverNow, at: Date.now() };
  }, [goAt, serverNow]);
  useEffect(() => {
    if (goAt == null || serverNow == null) {
      setMs(0);
      return;
    }
    const tick = () => {
      const b = baseRef.current;
      if (b.goAt == null || b.serverNow == null) return;
      setMs(Math.max(0, b.serverNow - b.goAt + (Date.now() - b.at)));
    };
    tick();
    const id = window.setInterval(tick, 40);
    return () => window.clearInterval(id);
  }, [goAt, serverNow]);
  return ms;
}

export default function ReactionGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<ReactionPublic, ReactionMe>) {
  const elapsed = useElapsed(pub.goAt, pub.serverNow);

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="reaction"
        title="Reflex test"
        blurb="Wait for the panel to turn green, then tap as fast as you can. Tap early and you are out for the round."
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        startLabel="Start"
        onStart={() => move("start")}
      />
    );
  }

  if (pub.phase === "arming" || pub.phase === "go") {
    const isGo = pub.phase === "go";
    const faulted = me.tapped && me.early;
    const tappedValid = me.tapped && !me.early;
    let bg = "#7a1f1a";
    let title = "Wait for green";
    let sub = `Round ${pub.round + 1} of ${pub.totalRounds}`;
    if (faulted) {
      bg = color.danger;
      title = "Too soon!";
      sub = "Sit tight until the next round";
    } else if (isGo) {
      bg = "#1d7a3f";
      title = tappedValid ? `${me.reactionMs} ms` : "TAP!";
      sub = tappedValid ? "Locked in" : `${pub.tappedCount}/${pub.totalPlayers} tapped`;
    }
    const canTap = !readOnly && !me.tapped;
    const handleTap = () => {
      void move("tap");
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 340 }}>
        <button
          type="button"
          disabled={!canTap}
          onPointerDown={(event) => {
            if (!canTap) return;
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            handleTap();
          }}
          onKeyDown={(event) => {
            if (!canTap || event.repeat) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            handleTap();
          }}
          style={{
            flex: 1,
            minHeight: 300,
            border: "none",
            borderRadius: radius.lg,
            background: bg,
            color: "#fff",
            cursor: canTap ? "pointer" : "default",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            transition: "background 120ms ease",
            touchAction: "manipulation",
          }}
        >
          <span style={{ fontFamily: HEAD_FONT, fontSize: isGo && !tappedValid ? 44 : 30, fontWeight: 500 }}>
            {title}
          </span>
          <span style={{ fontSize: 13, opacity: 0.85 }}>{sub}</span>
          {isGo && !readOnly && !me.tapped ? (
            <span style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{elapsed} ms</span>
          ) : null}
        </button>
      </div>
    );
  }

  if (pub.phase === "results") {
    const top = pub.scoreboard[0];
    return (
      <div>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "0 0 4px", textAlign: "center" }}>
          Sharpest reflexes
        </p>
        {top ? (
          <p style={{ fontSize: 13, color: color.accent, textAlign: "center", margin: "0 0 14px" }}>
            {top.name} takes it with {top.score}
          </p>
        ) : null}
        <Scoreboard rows={pub.scoreboard} />
      </div>
    );
  }

  // reveal
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 11, color: color.textFaint, margin: 0 }}>
        Round {pub.round + 1} of {pub.totalRounds}
      </p>
      {pub.winnerName ? (
        <p style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, margin: 0 }}>
          {pub.winnerName} was fastest
        </p>
      ) : (
        <p style={{ fontFamily: HEAD_FONT, fontSize: 16, color: color.textMuted, margin: 0 }}>
          Nobody made it in time
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pub.results.map((r, i) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: radius.md,
              background: i === 0 && !r.early ? color.accentSoft : color.surfaceRaised,
            }}
          >
            <span style={{ width: 16, fontSize: 12, color: color.textFaint, fontFamily: HEAD_FONT }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 14, color: color.text }}>{r.name}</span>
            <span style={{ fontSize: 13, fontFamily: HEAD_FONT, color: r.early ? color.danger : color.text }}>
              {r.early ? "too soon" : `${r.reactionMs} ms`}
            </span>
          </div>
        ))}
      </div>
      {isAdmin && !readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <GhostButton onClick={() => move("next")}>Next</GhostButton>
        </div>
      ) : null}
    </div>
  );
}

function Scoreboard({ rows }: { rows: { id: string; name: string; score: number }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((entry, index) => (
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
  );
}
