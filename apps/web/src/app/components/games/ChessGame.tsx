"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import {
  Avatar,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
  type GameViewProps,
} from "./gameUi";
import type { ChessMove } from "./moves";

type ChessSide = "white" | "black";
type ChessTurn = "w" | "b";
type ChessRole = "white-captain" | "black-captain" | "white-team" | "black-team" | "spectator";

type ChessTeamPlayer = {
  id: string;
  name: string;
  captain: boolean;
};

type ChessMoveRecord = {
  san: string;
  from: string;
  to: string;
  color: ChessTurn;
  byPlayerId: string;
  byName: string;
};

type ChessResult = {
  winner: ChessSide | "draw";
  reason: string;
  byName?: string;
};

type ChessPublic = {
  phase: "lobby" | "playing" | "results";
  mode: "duel" | "teams";
  serverNow: number;
  timeControlMs: number | null;
  clocks: Record<ChessSide, number | null>;
  fen: string;
  turn: ChessTurn;
  turnSide: ChessSide;
  inCheck: boolean;
  legalMoves: Record<string, string[]>;
  teams: Record<ChessSide, ChessTeamPlayer[]>;
  moves: ChessMoveRecord[];
  drawOffer: { side: ChessSide; byPlayerId: string; byName: string } | null;
  result: ChessResult | null;
};

type ChessMe = {
  side: ChessSide | null;
  role: ChessRole;
  canMove: boolean;
  canResign: boolean;
  canOfferDraw: boolean;
  canRespondToDraw: boolean;
};

type PieceCode = "P" | "N" | "B" | "R" | "Q" | "K" | "p" | "n" | "b" | "r" | "q" | "k";
type BoardCell = { square: string; piece: PieceCode | null; dark: boolean };

const PIECES: Record<PieceCode, string> = {
  P: "\u2659",
  N: "\u2658",
  B: "\u2657",
  R: "\u2656",
  Q: "\u2655",
  K: "\u2654",
  p: "\u265F",
  n: "\u265E",
  b: "\u265D",
  r: "\u265C",
  q: "\u265B",
  k: "\u265A",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];
const DARK_SQUARE = "#8d3f3a";
const LIGHT_SQUARE = "#f2e7db";
const ACTIVE_SQUARE = "#ef7047";
const TARGET_SQUARE = "rgba(239, 112, 71, 0.42)";

const WIN_QUOTES = [
  "A royal finish. Absolute endgame aura.",
  "That was not just a win. That was board control.",
  "Checkmate energy. Clean, calm, clinical.",
  "The crown stays with the cooler head.",
];

const parseBoard = (fen: string, side: ChessSide | null): BoardCell[] => {
  const placement = fen.split(" ")[0] ?? "";
  const rows = placement.split("/");
  const board: BoardCell[] = [];
  rows.forEach((row, rankIndex) => {
    let fileIndex = 0;
    for (const token of row) {
      const empty = Number(token);
      if (Number.isInteger(empty) && empty > 0) {
        for (let i = 0; i < empty; i += 1) {
          board.push(cell(fileIndex, rankIndex, null));
          fileIndex += 1;
        }
      } else {
        board.push(cell(fileIndex, rankIndex, token as PieceCode));
        fileIndex += 1;
      }
    }
  });
  return side === "black" ? board.reverse() : board;
};

const cell = (fileIndex: number, rankIndex: number, piece: PieceCode | null): BoardCell => ({
  square: `${FILES[fileIndex]}${RANKS[rankIndex]}`,
  piece,
  dark: (fileIndex + rankIndex) % 2 === 1,
});

const pieceSide = (piece: PieceCode | null): ChessSide | null => {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? "white" : "black";
};

const statusText = (pub: ChessPublic, me: ChessMe): string => {
  if (pub.result) {
    if (pub.result.winner === "draw") return `Draw by ${resultReason(pub.result.reason)}`;
    return `${sideLabel(pub.result.winner)} wins by ${resultReason(pub.result.reason)}`;
  }
  if (me.canMove) return "Your move";
  const captain = pub.teams[pub.turnSide].find((player) => player.captain)?.name;
  return `${sideLabel(pub.turnSide)} to move${captain ? ` - ${captain}` : ""}${pub.inCheck ? " - check" : ""}`;
};

export default function ChessGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<ChessPublic, ChessMe>) {
  const send = createTypedMove<ChessMove>(move);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const board = useMemo(() => parseBoard(pub.fen, me.side), [pub.fen, me.side]);
  const whiteClock = useChessClock(pub, "white");
  const blackClock = useChessClock(pub, "black");

  const dispatch = async (next: ChessMove) => {
    setError(null);
    const result = await send(next);
    if (!result.success) setError(result.error ?? "Move rejected");
  };

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="chess"
        title={pub.mode === "teams" ? "Captain-led team chess" : "Live chess duel"}
        blurb={
          pub.mode === "teams"
            ? "The room splits into White and Black. Each side can talk, but only its captain moves the pieces."
            : "Two live members are randomly seated as White and Black. No bot, no engine, just the board."
        }
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={players.length >= 2}
        disabledLabel="Need at least 2 players"
        onStart={() => dispatch({ type: "start" })}
      />
    );
  }

  const canMove = !readOnly && me.canMove;
  const selectedTargets = selected ? pub.legalMoves[selected] ?? [] : [];

  const handleSquare = (square: string, piece: PieceCode | null) => {
    if (!canMove) return;
    const ownPiece = pieceSide(piece) === me.side;
    if (!selected) {
      if (ownPiece) setSelected(square);
      return;
    }
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (ownPiece && !selectedTargets.includes(square)) {
      setSelected(square);
      return;
    }
    if (!selectedTargets.includes(square)) return;
    const promotion = shouldPromote(board.find((c) => c.square === selected)?.piece ?? null, square) ? "q" : undefined;
    setSelected(null);
    void dispatch({ type: "move", from: selected, to: square, promotion });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <ChessAnimationStyles />
      {pub.phase === "results" ? <ResultCelebration result={pub.result} /> : null}

      <div>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: 0 }}>
          {statusText(pub, me)}
        </p>
        <p style={{ fontSize: 12, color: color.textMuted, margin: "5px 0 0" }}>
          {me.role === "spectator" ? "Watching" : roleLabel(me.role)}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ClockRow
          side="black"
          team={pub.teams.black}
          active={pub.turnSide === "black" && pub.phase === "playing"}
          remainingMs={blackClock}
          totalMs={pub.timeControlMs}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
            gridTemplateRows: "repeat(8, minmax(0, 1fr))",
            width: "min(100%, 420px)",
            maxWidth: "100%",
            aspectRatio: "1 / 1",
            margin: "0 auto",
            borderRadius: 8,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.12)",
            background: LIGHT_SQUARE,
            boxShadow: "0 12px 28px rgba(0,0,0,0.24)",
            flex: "0 0 auto",
          }}
        >
          {board.map((cell) => {
            const active = selected === cell.square;
            const target = selectedTargets.includes(cell.square);
            const side = pieceSide(cell.piece);
            return (
              <button
                key={cell.square}
                type="button"
                disabled={!canMove}
                onClick={() => handleSquare(cell.square, cell.piece)}
                title={cell.square}
                aria-label={cell.piece ? `${cell.square} ${side ?? ""} piece` : cell.square}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: "100%",
                  minWidth: 0,
                  minHeight: 0,
                  aspectRatio: "1 / 1",
                  boxSizing: "border-box",
                  border: "none",
                  padding: 0,
                  overflow: "hidden",
                  background: active
                    ? ACTIVE_SQUARE
                    : target
                      ? TARGET_SQUARE
                      : cell.dark
                        ? DARK_SQUARE
                        : LIGHT_SQUARE,
                  cursor: canMove ? "pointer" : "default",
                }}
              >
                {cell.piece ? (
                  <span
                    aria-hidden="true"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      lineHeight: "1",
                      textAlign: "center",
                      color: side === "white" ? "#fffaf2" : "#18181b",
                      fontFamily: "'Segoe UI Symbol', 'Noto Sans Symbols 2', 'Apple Symbols', 'Arial Unicode MS', sans-serif",
                      fontSize: "clamp(23px, 8.5vw, 38px)",
                      transform: "translateY(5%)",
                      textShadow: side === "white"
                        ? "0 2px 2px rgba(0,0,0,0.44), 0 0 1px rgba(0,0,0,0.7)"
                        : "0 1px 1px rgba(255,255,255,0.25)",
                      pointerEvents: "none",
                      userSelect: "none",
                    }}
                  >
                    {PIECES[cell.piece]}
                  </span>
                ) : null}
                {target ? (
                  <span
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      width: cell.piece ? "72%" : 12,
                      height: cell.piece ? "72%" : 12,
                      borderRadius: "50%",
                      transform: "translate(-50%, -50%)",
                      background: cell.piece ? "transparent" : "rgba(24, 24, 27, 0.36)",
                      border: cell.piece ? "3px solid rgba(24, 24, 27, 0.35)" : "none",
                      pointerEvents: "none",
                    }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <ClockRow
          side="white"
          team={pub.teams.white}
          active={pub.turnSide === "white" && pub.phase === "playing"}
          remainingMs={whiteClock}
          totalMs={pub.timeControlMs}
        />
      </div>

      {error ? <p style={{ margin: 0, color: color.danger, fontSize: 12 }}>{error}</p> : null}
      {pub.drawOffer ? (
        <div style={{ padding: 10, borderRadius: radius.md, background: color.surfaceRaised, border: `1px solid ${color.border}` }}>
          <p style={{ margin: 0, fontSize: 13, color: color.text }}>
            {pub.drawOffer.byName} offered a draw.
          </p>
          {me.canRespondToDraw && !readOnly ? (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <PrimaryButton onClick={() => dispatch({ type: "acceptDraw" })}>Accept</PrimaryButton>
              <GhostButton onClick={() => dispatch({ type: "declineDraw" })}>Decline</GhostButton>
            </div>
          ) : null}
        </div>
      ) : null}

      <TeamList title="White" team={pub.teams.white} active={pub.turnSide === "white" && pub.phase === "playing"} />
      <TeamList title="Black" team={pub.teams.black} active={pub.turnSide === "black" && pub.phase === "playing"} />

      {pub.moves.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ margin: 0, color: color.textFaint, fontSize: 11, fontFamily: HEAD_FONT }}>Moves</p>
          {pub.moves.slice(-8).map((entry, index) => (
            <div key={`${entry.from}-${entry.to}-${index}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: color.textMuted }}>
              <span>{pub.moves.length - Math.min(pub.moves.length, 8) + index + 1}. {entry.san}</span>
              <span>{entry.byName}</span>
            </div>
          ))}
        </div>
      ) : null}

      {pub.phase === "playing" && (me.canOfferDraw || me.canResign) && !readOnly ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <GhostButton disabled={Boolean(pub.drawOffer)} onClick={() => dispatch({ type: "offerDraw" })}>
            Offer draw
          </GhostButton>
          <GhostButton onClick={() => dispatch({ type: "resign" })}>Resign</GhostButton>
        </div>
      ) : null}
    </div>
  );
}

function useChessClock(pub: ChessPublic, side: ChessSide): number | null {
  const [, setTick] = useState(0);
  const baseRef = useRef({ clocks: pub.clocks, serverNow: pub.serverNow, localAt: Date.now() });

  useEffect(() => {
    baseRef.current = { clocks: pub.clocks, serverNow: pub.serverNow, localAt: Date.now() };
  }, [pub.clocks, pub.serverNow, pub.turnSide, pub.phase]);

  useEffect(() => {
    if (pub.timeControlMs == null || pub.phase !== "playing") return;
    const id = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(id);
  }, [pub.phase, pub.timeControlMs]);

  const base = baseRef.current.clocks[side];
  if (base == null || pub.timeControlMs == null) return base;
  if (pub.phase !== "playing" || pub.turnSide !== side) return base;
  return Math.max(0, base - (Date.now() - baseRef.current.localAt));
}

function ClockRow({
  side,
  team,
  active,
  remainingMs,
  totalMs,
}: {
  side: ChessSide;
  team: ChessTeamPlayer[];
  active: boolean;
  remainingMs: number | null;
  totalMs: number | null;
}) {
  const low = active && totalMs != null && remainingMs != null && remainingMs <= totalMs * 0.1;
  const captain = team.find((player) => player.captain);
  return (
    <div
      className={low ? "chess-clock-low" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: radius.md,
        background: active ? "rgba(239, 112, 71, 0.16)" : color.surfaceRaised,
        border: `1px solid ${active ? "rgba(239, 112, 71, 0.48)" : color.border}`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: side === "white" ? "#fffaf2" : "#18181b", border: "1px solid rgba(255,255,255,0.35)" }} />
      <span style={{ minWidth: 0, flex: 1, fontSize: 12, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {sideLabel(side)}{captain ? ` - ${captain.name}` : ""}
      </span>
      <span style={{ fontFamily: HEAD_FONT, fontSize: 15, fontWeight: 600, color: low ? color.danger : color.text }}>
        {formatClock(remainingMs)}
      </span>
    </div>
  );
}

function ResultCelebration({ result }: { result: ChessResult | null }) {
  if (!result) return null;
  const title = result.winner === "draw" ? "Draw agreed" : `${sideLabel(result.winner)} wins`;
  const quote = WIN_QUOTES[Math.abs(result.reason.length + title.length) % WIN_QUOTES.length];
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: radius.md,
        padding: "14px 14px 16px",
        background: "linear-gradient(135deg, rgba(239,112,71,0.24), rgba(255,255,255,0.06))",
        border: "1px solid rgba(239,112,71,0.38)",
      }}
    >
      <div className="chess-confetti" />
      <p style={{ position: "relative", margin: 0, fontFamily: HEAD_FONT, fontSize: 18, color: color.text }}>
        {title}
      </p>
      <p style={{ position: "relative", margin: "5px 0 0", fontSize: 12.5, color: color.textMuted, lineHeight: 1.5 }}>
        {quote}
      </p>
    </div>
  );
}

function ChessAnimationStyles() {
  return (
    <style>{`
      @keyframes chess-clock-shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-1px); }
        50% { transform: translateX(1px); }
        75% { transform: translateX(-1px); }
      }
      @keyframes chess-confetti-rise {
        0% { transform: translateY(14px) rotate(0deg); opacity: 0; }
        18% { opacity: 1; }
        100% { transform: translateY(-46px) rotate(28deg); opacity: 0; }
      }
      .chess-clock-low {
        animation: chess-clock-shake 420ms ease-in-out infinite;
      }
      .chess-confetti::before,
      .chess-confetti::after {
        content: "";
        position: absolute;
        left: 12%;
        bottom: 0;
        width: 7px;
        height: 18px;
        border-radius: 2px;
        background: #ef7047;
        animation: chess-confetti-rise 1100ms ease-out infinite;
      }
      .chess-confetti::after {
        left: 82%;
        height: 14px;
        background: #fffaf2;
        animation-delay: 220ms;
      }
    `}</style>
  );
}

function formatClock(ms: number | null) {
  if (ms == null) return "\u221e";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function shouldPromote(piece: PieceCode | null, to: string) {
  if (piece === "P") return to.endsWith("8");
  if (piece === "p") return to.endsWith("1");
  return false;
}

function roleLabel(role: ChessRole): string {
  switch (role) {
    case "white-captain": return "White captain";
    case "black-captain": return "Black captain";
    case "white-team": return "White team";
    case "black-team": return "Black team";
    default: return "Watching";
  }
}

function sideLabel(side: ChessSide): string {
  return side === "white" ? "White" : "Black";
}

function resultReason(reason: string): string {
  switch (reason) {
    case "checkmate": return "checkmate";
    case "stalemate": return "stalemate";
    case "threefold": return "threefold repetition";
    case "insufficient": return "insufficient material";
    case "resignation": return "resignation";
    case "timeout": return "timeout";
    default: return reason;
  }
}

function TeamList({ title, team, active }: { title: string; team: ChessTeamPlayer[]; active: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, color: active ? color.accent : color.textFaint, fontSize: 11, fontFamily: HEAD_FONT }}>
        {title}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {team.map((player) => (
          <div
            key={player.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 8px",
              borderRadius: radius.pill,
              background: player.captain ? color.accentSoft : color.surfaceRaised,
              border: `1px solid ${player.captain ? color.accent : color.border}`,
            }}
          >
            <Avatar name={player.name} size={22} highlight={player.captain} />
            <span style={{ color: color.text, fontSize: 12, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {player.name}{player.captain ? " - lead" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
