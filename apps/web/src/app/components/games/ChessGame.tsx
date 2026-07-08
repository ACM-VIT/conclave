"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import {
  GameLobby,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
  useRemaining,
  type GameViewProps,
} from "./gameUi";
import { ChessPiece, type PieceCode } from "./chessPieces";
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
  auto?: boolean;
};

type ChessResult = {
  winner: ChessSide | "draw";
  reason: string;
  byName?: string;
};

type SideOffer = { side: ChessSide; byPlayerId: string; byName: string };

type ChessPublic = {
  phase: "lobby" | "playing" | "results";
  mode: "duel" | "teams" | "computer";
  serverNow: number;
  timeControlMs: number | null;
  incrementMs: number;
  moveTimeMs: number | null;
  allowTakebacks: boolean;
  bot: { side: ChessSide; level: string; name: string } | null;
  clocks: Record<ChessSide, number | null>;
  fen: string;
  turn: ChessTurn;
  turnSide: ChessSide;
  turnStartedAt: number | null;
  inCheck: boolean;
  legalMoves: Record<string, string[]>;
  teams: Record<ChessSide, ChessTeamPlayer[]>;
  moves: ChessMoveRecord[];
  drawOffer: SideOffer | null;
  takebackRequest: SideOffer | null;
  result: ChessResult | null;
};

type ChessMe = {
  side: ChessSide | null;
  role: ChessRole;
  canMove: boolean;
  canResign: boolean;
  canOfferDraw: boolean;
  canRespondToDraw: boolean;
  canRequestTakeback: boolean;
  canRespondToTakeback: boolean;
};

type BoardCell = {
  square: string;
  piece: PieceCode | null;
  dark: boolean;
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

/* Board palette: warm cream + muted brick, tuned for the app's dark surface.
 * Highlights are flat translucent overlays (no gradients, no shadows). */
const LIGHT_SQUARE = "#EFE3CF";
const DARK_SQUARE = "#9A5C4C";
const LIGHT_COORD = "rgba(90, 44, 36, 0.55)";
const DARK_COORD = "rgba(239, 227, 207, 0.65)";
const LAST_MOVE_TINT = "rgba(233, 180, 76, 0.42)";
const SELECTED_TINT = "rgba(249, 95, 74, 0.55)";
const CHECK_TINT = "rgba(234, 67, 53, 0.55)";
const TARGET_DOT = "rgba(26, 20, 18, 0.34)";

const PIECE_POINTS: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"] as const;

const WIN_QUOTES = [
  "A royal finish. Absolute endgame aura.",
  "That was not just a win. That was board control.",
  "Checkmate energy. Clean, calm, clinical.",
  "The crown stays with the cooler head.",
];

const parseBoard = (fen: string, orientation: ChessSide): BoardCell[] => {
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
  return orientation === "black" ? board.reverse() : board;
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

const sideLabel = (side: ChessSide): string => (side === "white" ? "White" : "Black");

const otherSide = (side: ChessSide): ChessSide => (side === "white" ? "black" : "white");

const isPawn = (piece: PieceCode | null): boolean => piece === "P" || piece === "p";

const promotionRank = (side: ChessSide): string => (side === "white" ? "8" : "1");

/** Pieces `side` has captured so far (derived from what is missing off the fen). */
const capturedBy = (fen: string, side: ChessSide): { piece: PieceCode; count: number }[] => {
  const placement = fen.split(" ")[0] ?? "";
  const counts: Record<string, number> = {};
  for (const ch of placement) {
    if (/[a-zA-Z]/.test(ch)) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const result: { piece: PieceCode; count: number }[] = [];
  for (const type of CAPTURE_ORDER) {
    // White captures black (lowercase) pieces, and vice versa.
    const key = side === "white" ? type : type.toUpperCase();
    const missing = START_COUNTS[type] - (counts[key] ?? 0);
    if (missing > 0) result.push({ piece: key as PieceCode, count: missing });
  }
  return result;
};

const materialPoints = (captured: { piece: PieceCode; count: number }[]): number =>
  captured.reduce((sum, entry) => sum + PIECE_POINTS[entry.piece.toLowerCase()] * entry.count, 0);

const formatClock = (ms: number | null): string => {
  if (ms == null) return "--:--";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const timeControlLabel = (pub: ChessPublic): string => {
  if (pub.timeControlMs == null) return "No clock";
  const minutes = Math.round(pub.timeControlMs / 60_000);
  const increment = Math.round(pub.incrementMs / 1000);
  return increment > 0 ? `${minutes} | ${increment}` : `${minutes} min`;
};

const resultReason = (reason: string): string => {
  switch (reason) {
    case "checkmate": return "checkmate";
    case "stalemate": return "stalemate";
    case "threefold": return "threefold repetition";
    case "insufficient": return "insufficient material";
    case "fifty-move": return "the fifty-move rule";
    case "agreement": return "agreement";
    case "resignation": return "resignation";
    case "timeout": return "timeout";
    default: return reason;
  }
};

const roleLabel = (role: ChessRole, mode: ChessPublic["mode"]): string => {
  switch (role) {
    case "white-captain": return mode === "duel" || mode === "computer" ? "You play White" : "White captain — you move";
    case "black-captain": return mode === "duel" || mode === "computer" ? "You play Black" : "Black captain — you move";
    case "white-team": return "White team — call the moves together";
    case "black-team": return "Black team — call the moves together";
    default: return "Watching";
  }
};

const teamDisplayName = (pub: ChessPublic, side: ChessSide): string => {
  const team = pub.teams[side];
  if (pub.bot && pub.bot.side === side) return pub.bot.name;
  const captain = team.find((player) => player.captain);
  if (!captain) return sideLabel(side);
  const others = team.length - 1;
  return others > 0 ? `${captain.name} +${others}` : captain.name;
};

const statusText = (pub: ChessPublic, me: ChessMe): string => {
  if (pub.result) {
    if (pub.result.winner === "draw") return "Draw";
    return `${sideLabel(pub.result.winner)} wins`;
  }
  if (me.canMove) return "Your move";
  return `${sideLabel(pub.turnSide)} to move — ${teamDisplayName(pub, pub.turnSide)}`;
};

/** Local ticking clocks anchored to the last server broadcast. */
function useChessClocks(pub: ChessPublic): Record<ChessSide, number | null> {
  const [, setTick] = useState(0);
  const anchorRef = useRef({ clocks: pub.clocks, localAt: Date.now() });

  useEffect(() => {
    anchorRef.current = { clocks: pub.clocks, localAt: Date.now() };
  }, [pub.clocks, pub.serverNow, pub.turnSide, pub.phase]);

  useEffect(() => {
    if (pub.timeControlMs == null || pub.phase !== "playing") return;
    const id = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(id);
  }, [pub.phase, pub.timeControlMs]);

  const anchor = anchorRef.current;
  const compute = (side: ChessSide): number | null => {
    const base = anchor.clocks[side];
    if (base == null) return null;
    if (pub.phase !== "playing" || pub.turnSide !== side) return base;
    return Math.max(0, base - (Date.now() - anchor.localAt));
  };
  return { white: compute("white"), black: compute("black") };
}

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
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const orientation: ChessSide = me.side ?? "white";
  const board = useMemo(() => parseBoard(pub.fen, orientation), [pub.fen, orientation]);
  const captured = useMemo(
    () => ({ white: capturedBy(pub.fen, "white"), black: capturedBy(pub.fen, "black") }),
    [pub.fen],
  );
  const materialLead = materialPoints(captured.white) - materialPoints(captured.black);
  const clocks = useChessClocks(pub);

  // The position moved on without us (opponent move, rapid-fire auto-move,
  // accepted takeback): a pending promotion choice no longer applies.
  useEffect(() => {
    setPendingPromotion(null);
  }, [pub.fen]);
  const moveDeadline =
    pub.moveTimeMs != null && pub.turnStartedAt != null && pub.phase === "playing"
      ? pub.turnStartedAt + pub.moveTimeMs
      : null;
  const moveRemaining = useRemaining(moveDeadline, pub.serverNow);

  const dispatch = async (next: ChessMove) => {
    setError(null);
    const result = await send(next);
    if (!result.success) setError(result.error ?? "Move rejected");
  };

  if (pub.phase === "lobby") {
    return <ChessLobby pub={pub} players={players} userId={userId} isAdmin={isAdmin} readOnly={readOnly} onStart={() => dispatch({ type: "start" })} />;
  }

  const canMove = !readOnly && me.canMove && !pub.result;
  const selectedTargets = selected ? pub.legalMoves[selected] ?? [] : [];
  const lastMove = pub.moves.length > 0 ? pub.moves[pub.moves.length - 1] : null;
  const checkedKing = pub.inCheck ? (pub.turnSide === "white" ? "K" : "k") : null;

  const handleSquare = (square: string, piece: PieceCode | null) => {
    if (!canMove) return;
    setPendingPromotion(null);
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
    const movingPiece = board.find((c) => c.square === selected)?.piece ?? null;
    if (isPawn(movingPiece) && me.side && square.endsWith(promotionRank(me.side))) {
      // Let the player choose the promotion piece instead of silently queening.
      setPendingPromotion({ from: selected, to: square });
      setSelected(null);
      return;
    }
    setSelected(null);
    void dispatch({ type: "move", from: selected, to: square });
  };

  const confirmPromotion = (promotion: "q" | "r" | "b" | "n") => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);
    void dispatch({ type: "move", from, to, promotion });
  };

  const topSide = otherSide(orientation);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <ChessAnimationStyles />

      <div>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 17, fontWeight: 500, color: color.text, margin: 0 }}>
          {statusText(pub, me)}
          {pub.inCheck && !pub.result ? (
            <span
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: radius.pill,
                background: color.dangerSoft,
                color: color.danger,
                fontSize: 11,
                fontWeight: 500,
                verticalAlign: "2px",
              }}
            >
              Check
            </span>
          ) : null}
        </p>
        <p style={{ fontSize: 12, color: color.textMuted, margin: "4px 0 0" }}>
          {pub.result
            ? resultSubline(pub.result)
            : roleLabel(me.role, pub.mode)}
        </p>
      </div>

      {pub.result ? <ResultCard pub={pub} /> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <PlayerBar
          pub={pub}
          side={topSide}
          captured={captured[topSide]}
          lead={topSide === "white" ? materialLead : -materialLead}
          clockMs={clocks[topSide]}
          moveRemainingMs={moveRemaining}
        />

        <div style={{ position: "relative", width: "min(100%, 440px)", margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
              gridTemplateRows: "repeat(8, minmax(0, 1fr))",
              width: "100%",
              aspectRatio: "1 / 1",
              borderRadius: radius.md,
              overflow: "hidden",
              border: `1px solid ${color.border}`,
            }}
          >
            {board.map((boardCell, index) => (
              <Square
                key={boardCell.square}
                cell={boardCell}
                index={index}
                canMove={canMove}
                selected={selected === boardCell.square}
                target={selectedTargets.includes(boardCell.square)}
                lastMove={lastMove != null && (lastMove.from === boardCell.square || lastMove.to === boardCell.square)}
                checked={checkedKing != null && boardCell.piece === checkedKing}
                onPress={() => handleSquare(boardCell.square, boardCell.piece)}
              />
            ))}
          </div>
          {pendingPromotion && me.side ? (
            <PromotionPicker
              side={me.side}
              onPick={confirmPromotion}
              onCancel={() => setPendingPromotion(null)}
            />
          ) : null}
        </div>

        <PlayerBar
          pub={pub}
          side={orientation}
          captured={captured[orientation]}
          lead={orientation === "white" ? materialLead : -materialLead}
          clockMs={clocks[orientation]}
          moveRemainingMs={moveRemaining}
        />
      </div>

      {error ? <p style={{ margin: 0, color: color.danger, fontSize: 12 }}>{error}</p> : null}

      {pub.drawOffer && !pub.result ? (
        <OfferBanner
          text={`${pub.drawOffer.byName} offered a draw.`}
          canRespond={me.canRespondToDraw && !readOnly}
          onAccept={() => dispatch({ type: "acceptDraw" })}
          onDecline={() => dispatch({ type: "declineDraw" })}
        />
      ) : null}

      {pub.takebackRequest && !pub.result ? (
        <OfferBanner
          text={`${pub.takebackRequest.byName} asked to take back a move.`}
          canRespond={me.canRespondToTakeback && !readOnly}
          onAccept={() => dispatch({ type: "acceptTakeback" })}
          onDecline={() => dispatch({ type: "declineTakeback" })}
        />
      ) : null}

      {pub.phase === "playing" && !readOnly && (me.canRequestTakeback || me.canOfferDraw || me.canResign) ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {me.canRequestTakeback ? (
            <GhostButton disabled={Boolean(pub.takebackRequest)} onClick={() => dispatch({ type: "requestTakeback" })}>
              Takeback
            </GhostButton>
          ) : null}
          {me.canOfferDraw ? (
            <GhostButton disabled={Boolean(pub.drawOffer)} onClick={() => dispatch({ type: "offerDraw" })}>
              Offer draw
            </GhostButton>
          ) : null}
          {me.canResign ? (
            <GhostButton onClick={() => dispatch({ type: "resign" })}>Resign</GhostButton>
          ) : null}
        </div>
      ) : null}

      <MoveStrip moves={pub.moves} />
    </div>
  );
}

function ChessLobby({
  pub,
  players,
  userId,
  isAdmin,
  readOnly,
  onStart,
}: {
  pub: ChessPublic;
  players: { id: string; name: string }[];
  userId: string | null;
  isAdmin: boolean;
  readOnly: boolean;
  onStart: () => void;
}) {
  const settings: string[] = [timeControlLabel(pub)];
  if (pub.moveTimeMs != null) settings.push(`rapid fire ${Math.round(pub.moveTimeMs / 1000)}s a move`);
  if (!pub.allowTakebacks) settings.push("no takebacks");
  const settingsLine = `Playing ${settings.join(", ")}.`;

  const title =
    pub.mode === "teams"
      ? "Captain-led team chess"
      : pub.mode === "computer"
        ? players.length > 1
          ? "The room vs the computer"
          : "You vs the computer"
        : "Live chess duel";
  const blurb =
    pub.mode === "teams"
      ? `The room splits into White and Black. Each side can talk, but only its captain moves the pieces. ${settingsLine}`
      : pub.mode === "computer"
        ? `${pub.bot?.name ?? "The computer"} takes ${pub.bot ? sideLabel(pub.bot.side) : "a side"}; whoever starts leads the other. Takebacks are always granted. ${settingsLine}`
        : `Two live members are randomly seated as White and Black. ${settingsLine}`;
  const needed = pub.mode === "computer" ? 1 : 2;

  return (
    <GameLobby
      gameId="chess"
      title={title}
      blurb={blurb}
      players={players}
      userId={userId}
      isAdmin={isAdmin}
      readOnly={readOnly}
      canStart={players.length >= needed}
      disabledLabel={`Need at least ${needed} ${needed === 1 ? "player" : "players"}`}
      onStart={onStart}
    />
  );
}

function Square({
  cell: boardCell,
  index,
  canMove,
  selected,
  target,
  lastMove,
  checked,
  onPress,
}: {
  cell: BoardCell;
  index: number;
  canMove: boolean;
  selected: boolean;
  target: boolean;
  lastMove: boolean;
  checked: boolean;
  onPress: () => void;
}) {
  const overlay = selected
    ? SELECTED_TINT
    : checked
      ? CHECK_TINT
      : lastMove
        ? LAST_MOVE_TINT
        : null;
  const coordColor = boardCell.dark ? DARK_COORD : LIGHT_COORD;
  const showRank = index % 8 === 0;
  const showFile = Math.floor(index / 8) === 7;

  return (
    <button
      type="button"
      disabled={!canMove}
      onClick={onPress}
      aria-label={boardCell.piece ? `${boardCell.square}, ${pieceSide(boardCell.piece)} piece` : boardCell.square}
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        border: "none",
        padding: 0,
        background: boardCell.dark ? DARK_SQUARE : LIGHT_SQUARE,
        cursor: canMove ? "pointer" : "default",
      }}
    >
      {overlay ? <span style={{ position: "absolute", inset: 0, background: overlay, pointerEvents: "none" }} /> : null}
      {showRank ? (
        <span style={{ position: "absolute", top: 1, left: 3, fontSize: 9, fontWeight: 600, color: coordColor, pointerEvents: "none", fontFamily: HEAD_FONT }}>
          {boardCell.square[1]}
        </span>
      ) : null}
      {showFile ? (
        <span style={{ position: "absolute", bottom: 1, right: 3, fontSize: 9, fontWeight: 600, color: coordColor, pointerEvents: "none", fontFamily: HEAD_FONT }}>
          {boardCell.square[0]}
        </span>
      ) : null}
      {boardCell.piece ? (
        <span style={{ position: "absolute", inset: "6%", pointerEvents: "none" }}>
          <ChessPiece piece={boardCell.piece} />
        </span>
      ) : null}
      {target ? (
        boardCell.piece ? (
          <span
            style={{
              position: "absolute",
              inset: "4%",
              borderRadius: "50%",
              border: `3px solid ${TARGET_DOT}`,
              pointerEvents: "none",
            }}
          />
        ) : (
          <span
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: "26%",
              height: "26%",
              transform: "translate(-50%, -50%)",
              borderRadius: "50%",
              background: TARGET_DOT,
              pointerEvents: "none",
            }}
          />
        )
      ) : null}
    </button>
  );
}

function PlayerBar({
  pub,
  side,
  captured,
  lead,
  clockMs,
  moveRemainingMs,
}: {
  pub: ChessPublic;
  side: ChessSide;
  captured: { piece: PieceCode; count: number }[];
  lead: number;
  clockMs: number | null;
  moveRemainingMs: number;
}) {
  const active = pub.phase === "playing" && pub.turnSide === side && !pub.result;
  const timed = pub.timeControlMs != null;
  const low = active && timed && clockMs != null && (clockMs <= pub.timeControlMs! * 0.1 || clockMs <= 15_000);
  const rapidFireRatio =
    active && pub.moveTimeMs != null ? Math.max(0, Math.min(1, moveRemainingMs / pub.moveTimeMs)) : null;

  return (
    <div
      className={low ? "chess-clock-low" : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "7px 10px",
        borderRadius: radius.md,
        background: active ? color.accentSoft : color.surfaceRaised,
        border: `1px solid ${active ? color.accent : color.border}`,
        overflow: "hidden",
        width: "min(100%, 440px)",
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          flexShrink: 0,
          background: side === "white" ? "#F5F1E8" : "#26211E",
          border: `1px solid ${color.borderStrong}`,
        }}
      />
      <span
        style={{
          minWidth: 0,
          flex: 1,
          fontSize: 13,
          color: color.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: HEAD_FONT,
        }}
      >
        {teamDisplayName(pub, side)}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
        {captured.map((entry) =>
          Array.from({ length: entry.count }, (_, i) => (
            <span key={`${entry.piece}${i}`} style={{ width: 13, height: 13, opacity: 0.85 }}>
              <ChessPiece piece={entry.piece} />
            </span>
          )),
        )}
        {lead > 0 ? (
          <span style={{ fontSize: 11, color: color.textMuted, marginLeft: 3 }}>+{lead}</span>
        ) : null}
      </span>
      {timed ? (
        <span
          style={{
            fontFamily: HEAD_FONT,
            fontSize: 15,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: low ? color.danger : active ? color.text : color.textMuted,
            flexShrink: 0,
          }}
        >
          {formatClock(clockMs)}
        </span>
      ) : rapidFireRatio != null ? (
        <span
          style={{
            fontFamily: HEAD_FONT,
            fontSize: 15,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: moveRemainingMs <= 3_000 ? color.danger : color.text,
            flexShrink: 0,
          }}
        >
          {formatClock(moveRemainingMs)}
        </span>
      ) : null}
      {rapidFireRatio != null ? (
        <span
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            height: 2,
            width: `${rapidFireRatio * 100}%`,
            background: moveRemainingMs <= 3_000 ? color.danger : color.accent,
            transition: "width 200ms linear",
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
}

function PromotionPicker({
  side,
  onPick,
  onCancel,
}: {
  side: ChessSide;
  onPick: (promotion: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) {
  const options: { code: "q" | "r" | "b" | "n"; piece: PieceCode }[] =
    side === "white"
      ? [
          { code: "q", piece: "Q" },
          { code: "r", piece: "R" },
          { code: "b", piece: "B" },
          { code: "n", piece: "N" },
        ]
      : [
          { code: "q", piece: "q" },
          { code: "r", piece: "r" },
          { code: "b", piece: "b" },
          { code: "n", piece: "n" },
        ];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(24, 24, 27, 0.66)",
        borderRadius: radius.md,
        zIndex: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: 12,
          borderRadius: radius.md,
          background: color.surfaceRaised,
          border: `1px solid ${color.border}`,
        }}
      >
        <span style={{ fontSize: 12, color: color.textMuted, fontFamily: HEAD_FONT }}>Promote to</span>
        <div style={{ display: "flex", gap: 6 }}>
          {options.map((option) => (
            <button
              key={option.code}
              type="button"
              onClick={() => onPick(option.code)}
              aria-label={`Promote to ${option.code}`}
              style={{
                width: 52,
                height: 52,
                padding: 6,
                borderRadius: radius.sm,
                border: `1px solid ${color.border}`,
                background: LIGHT_SQUARE,
                cursor: "pointer",
              }}
            >
              <ChessPiece piece={option.piece} />
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          style={{
            border: "none",
            background: "transparent",
            color: color.textFaint,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: HEAD_FONT,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function OfferBanner({
  text,
  canRespond,
  onAccept,
  onDecline,
}: {
  text: string;
  canRespond: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "9px 12px",
        borderRadius: radius.md,
        background: color.surfaceRaised,
        border: `1px solid ${color.borderStrong}`,
      }}
    >
      <p style={{ margin: 0, flex: 1, minWidth: 140, fontSize: 13, color: color.text }}>{text}</p>
      {canRespond ? (
        <span style={{ display: "flex", gap: 8 }}>
          <PrimaryButton onClick={onAccept}>Accept</PrimaryButton>
          <GhostButton onClick={onDecline}>Decline</GhostButton>
        </span>
      ) : (
        <span style={{ fontSize: 12, color: color.textFaint }}>Waiting…</span>
      )}
    </div>
  );
}

const resultSubline = (result: ChessResult): string => {
  if (result.reason === "resignation") return `${result.byName ?? "A captain"} resigned.`;
  if (result.reason === "agreement") return "Draw agreed.";
  if (result.winner === "draw") return `Draw by ${resultReason(result.reason)}.`;
  return `By ${resultReason(result.reason)}.`;
};

function ResultCard({ pub }: { pub: ChessPublic }) {
  const result = pub.result;
  if (!result) return null;
  const win = result.winner !== "draw";
  const title = win ? `${sideLabel(result.winner as ChessSide)} wins` : "Draw";
  const detail = win
    ? `${teamDisplayName(pub, result.winner as ChessSide)} takes it by ${resultReason(result.reason)}.`
    : resultSubline(result);
  const quote = win ? WIN_QUOTES[(pub.moves.length + result.reason.length) % WIN_QUOTES.length] : null;
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: radius.md,
        background: color.surfaceRaised,
        border: `1px solid ${win ? color.accent : color.borderStrong}`,
      }}
    >
      <p style={{ margin: 0, fontFamily: HEAD_FONT, fontSize: 16, fontWeight: 500, color: win ? color.accent : color.text }}>
        {title}
      </p>
      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: color.textMuted, lineHeight: 1.5 }}>
        {detail}
        {quote ? ` ${quote}` : ""}
      </p>
    </div>
  );
}

function MoveStrip({ moves }: { moves: ChessMoveRecord[] }) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip) strip.scrollLeft = strip.scrollWidth;
  }, [moves.length]);

  if (moves.length === 0) return null;

  const pairs: { number: number; white?: ChessMoveRecord; black?: ChessMoveRecord }[] = [];
  for (const entry of moves) {
    if (entry.color === "w") {
      pairs.push({ number: pairs.length + 1, white: entry });
    } else if (pairs.length === 0) {
      pairs.push({ number: 1, black: entry });
    } else {
      pairs[pairs.length - 1].black = entry;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p style={{ margin: 0, color: color.textFaint, fontSize: 11, fontFamily: HEAD_FONT }}>Moves</p>
      <div
        ref={stripRef}
        style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "thin" }}
      >
        {pairs.map((pair) => (
          <span
            key={pair.number}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: 5,
              flexShrink: 0,
              padding: "4px 8px",
              borderRadius: radius.sm,
              background: color.surfaceRaised,
              border: `1px solid ${color.border}`,
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span style={{ color: color.textFaint }}>{pair.number}.</span>
            {pair.white ? <MoveSan entry={pair.white} /> : null}
            {pair.black ? <MoveSan entry={pair.black} /> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function MoveSan({ entry }: { entry: ChessMoveRecord }) {
  return (
    <span
      title={entry.auto ? `Auto-played for ${entry.byName}` : entry.byName}
      style={{ color: entry.auto ? "#E9B44C" : color.text }}
    >
      {entry.san}
    </span>
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
      .chess-clock-low {
        animation: chess-clock-shake 420ms ease-in-out infinite;
      }
    `}</style>
  );
}
