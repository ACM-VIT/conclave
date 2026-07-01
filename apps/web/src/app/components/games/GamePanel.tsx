"use client";

import { useState } from "react";
import { useGame } from "@conclave/apps-sdk";
import { color } from "@conclave/ui-tokens";
import {
  GAME_DOCK_HEADER_CLASS,
  GAME_DOCK_PANEL_CLASS,
  GAME_DOCK_TITLE_CLASS,
  GameDockResizeHandle,
  HEAD_FONT,
  Leaderboard,
} from "./gameUi";
import { getGameRenderer } from "./registry";

type ScoreRow = { id: string; name: string; score: number };

const readScoreboard = (view: unknown): ScoreRow[] | null => {
  const board = (view as { scoreboard?: unknown } | null)?.scoreboard;
  if (!Array.isArray(board)) return null;
  return board.filter(
    (r): r is ScoreRow =>
      Boolean(r) && typeof r.id === "string" && typeof r.name === "string" && typeof r.score === "number",
  );
};

/**
 * The active game as a right-docked panel (same dock model as Chat/Participants).
 * The video grid keeps the main stage and reserves width for this panel, so the
 * game sits beside the group instead of taking over an empty stage. On mobile it
 * becomes a full-width sheet that respects the safe-area insets.
 */
export function GamePanel({
  rightOffset = 0,
  dockWidth,
  maxDockWidth,
  onDockWidthChange,
}: {
  rightOffset?: number;
  dockWidth?: number;
  maxDockWidth?: number;
  onDockWidthChange?: (width: number) => void;
}) {
  const { publicState, view, isAdmin, isReadOnly, userId, move, endGame, startGame } =
    useGame();
  const [rematchBusy, setRematchBusy] = useState(false);
  if (!publicState) return null;

  const canControl = isAdmin && !isReadOnly;
  const showRematch = canControl && publicState.finished;

  const handleRematch = async () => {
    if (rematchBusy) return;
    setRematchBusy(true);
    try {
      await startGame(publicState.gameId, publicState.config);
    } finally {
      setRematchBusy(false);
    }
  };

  const Game = getGameRenderer(publicState.gameId);
  const isPlayer = Boolean(
    userId && publicState.players.some((player) => player.id === userId),
  );

  return (
    <aside
      className={GAME_DOCK_PANEL_CLASS}
      style={{ right: rightOffset, width: dockWidth, fontFamily: HEAD_FONT }}
      aria-label={`${publicState.name} game`}
    >
      <GameDockResizeHandle
        width={dockWidth}
        maxWidth={maxDockWidth}
        onWidthChange={onDockWidthChange}
      />
      <div className={GAME_DOCK_HEADER_CLASS}>
        <div className="flex h-8 min-w-0 items-center gap-2">
          <h2 className={GAME_DOCK_TITLE_CLASS}>{publicState.name}</h2>
        </div>
        {canControl ? (
          <div className="ml-2 flex shrink-0 items-center gap-2">
            {showRematch ? (
              <button
                type="button"
                onClick={handleRematch}
                disabled={rematchBusy}
                style={{ backgroundColor: color.accent }}
                className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {rematchBusy ? "Starting" : "Play again"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => endGame()}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-white/10 px-3 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
            >
              End game
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!Game ? (
          <p style={{ fontSize: 13, color: color.textFaint }}>
            This game is not supported on web yet.
          </p>
        ) : !isPlayer ? (
          <div style={{ padding: "18px 4px", textAlign: "center" }}>
            <p style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, margin: 0 }}>
              Game in progress
            </p>
            <p style={{ fontSize: 13, color: color.textMuted, lineHeight: 1.5, margin: "8px 0 0" }}>
              This round started before you joined. You can watch the room and join the next game.
            </p>
          </div>
        ) : view == null ? (
          <div style={{ padding: "18px 4px", textAlign: "center" }}>
            <p style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, margin: 0 }}>
              Loading your game view
            </p>
            <p style={{ fontSize: 13, color: color.textMuted, lineHeight: 1.5, margin: "8px 0 0" }}>
              Waiting for the server to send your private view.
            </p>
          </div>
        ) : (
          <>
            <Game
              pub={publicState.view as never}
              me={view as never}
              players={publicState.players}
              isAdmin={isAdmin}
              readOnly={isReadOnly}
              userId={userId}
              hostId={publicState.hostId}
              phase={publicState.phase}
              move={move}
            />
            {publicState.hasLeaderboard &&
            publicState.phase !== "lobby" &&
            publicState.phase !== "results" ? (
              <Leaderboard rows={readScoreboard(publicState.view) ?? []} userId={userId} />
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
