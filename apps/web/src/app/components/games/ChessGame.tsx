"use client";

import React, { useMemo, useState } from "react";
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

type ChessPublic = {
  phase: "lobby" | "playing" | "results";
  mode: "duel" | "teams";
  fen: string;
  turn: ChessTurn;
  turnSide: ChessSide;
  inCheck: boolean;
  legalMoves: Record<string, string[]>;
  teams: Record<ChessSide, ChessTeamPlayer[]>;
  moves: ChessMoveRecord[];
  drawOffer: { side: ChessSide; byPlayerId: string; byName: string } | null;
  result: { winner: ChessSide | "draw"; reason: string; byName?: string } | null;
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
  P: "♙",
  N: "♘",
  B: "♗",
  R: "♖",
  Q: "♕",
  K: "♔",
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

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
    if (pub.result.winner === "draw") return `Draw by ${pub.result.reason}`;
    return `${pub.result.winner === "white" ? "White" : "Black"} wins by ${pub.result.reason}`;
  }
  if (me.canMove) return "Your move";
  const turn = pub.turnSide === "white" ? "White" : "Black";
  const captain = pub.teams[pub.turnSide].find((player) => player.captain)?.name;
  return `${turn} to move${captain ? ` · ${captain}` : ""}${pub.inCheck ? " · check" : ""}`;
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
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: 0 }}>
          {statusText(pub, me)}
        </p>
        <p style={{ fontSize: 12, color: color.textMuted, margin: "5px 0 0" }}>
          {me.role === "spectator" ? "Watching" : roleLabel(me.role)}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
          width: "100%",
          aspectRatio: "1 / 1",
          borderRadius: radius.md,
          overflow: "hidden",
          border: `1px solid ${color.border}`,
          background: color.surfaceRaised,
        }}
      >
        {board.map((cell) => {
          const active = selected === cell.square;
          const target = selectedTargets.includes(cell.square);
          return (
            <button
              key={cell.square}
              type="button"
              disabled={!canMove}
              onClick={() => handleSquare(cell.square, cell.piece)}
              title={cell.square}
              style={{
                position: "relative",
                border: "none",
                padding: 0,
                background: active
                  ? "rgba(239, 112, 71, 0.88)"
                  : target
                    ? "rgba(239, 112, 71, 0.32)"
                    : cell.dark
                      ? "#60725f"
                      : "#d8c7a3",
                color: pieceSide(cell.piece) === "white" ? "#fafafa" : "#151515",
                fontSize: 30,
                lineHeight: 1,
                cursor: canMove ? "pointer" : "default",
                fontFamily: "Georgia, serif",
              }}
            >
              {cell.piece ? PIECES[cell.piece] : ""}
              {target ? (
                <span
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    transform: "translate(-50%, -50%)",
                    background: cell.piece ? "transparent" : "rgba(24, 24, 27, 0.45)",
                    border: cell.piece ? "2px solid rgba(24, 24, 27, 0.45)" : "none",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
            </button>
          );
        })}
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
              {player.name}{player.captain ? " · lead" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
