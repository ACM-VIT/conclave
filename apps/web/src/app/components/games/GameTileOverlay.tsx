"use client";

import { useState } from "react";
import { Check, Clock, Crown, Skull, X, Zap } from "lucide-react";
import {
  getTileAction,
  getTileResolver,
  resolveTileAdornment,
  resolveTileToneColor,
  useGame,
  type PlayerTileState,
  type TileMarkIcon,
} from "@conclave/apps-sdk";
import { accentFor } from "./covers";
import "./tileResolvers";

/**
 * Game adornments and controls drawn on a participant video tile, so the video
 * grid doubles as the game board. It reads the game's views into a semantic
 * PlayerTileState (via the game's registered resolver plus a universal
 * leaderboard rank), maps that to visual primitives through the SDK, and draws
 * them. When the game registers a tile action (tap a face to vote), the tile
 * becomes the controller. Outside a game, or for a non-player, it renders
 * nothing.
 *
 * ID MAPPING: a web participant.userId and a game player.id are the same
 * server-produced identity string (baseId#sessionId, lowercased). Remote tiles
 * pass the participant's userId straight from the SFU snapshot. The local self
 * tile omits the prop and the overlay falls back to useGame().userId, which is
 * the SERVER-CANONICAL selfId carried on game snapshots (never an id rebuilt
 * client-side, which can drift on email casing or session id). Any unmatched
 * id renders nothing (fail safe) rather than guessing.
 */
const matchesPlayer = (userId: string, playerId: string): boolean =>
  userId === playerId;

type ScoreRow = { id: string; name: string; score: number };

function readScoreboard(view: unknown): ScoreRow[] | null {
  if (!view || typeof view !== "object") return null;
  const board = (view as { scoreboard?: unknown }).scoreboard;
  if (!Array.isArray(board)) return null;
  return board as ScoreRow[];
}

/**
 * Live leaderboard position via competition ranking (ties share a rank), only
 * once standings are meaningful (someone has scored). Applied to every
 * leaderboard game so resolvers do not each reimplement it.
 */
function rankFromScoreboard(view: unknown, userId: string): number | undefined {
  const board = readScoreboard(view);
  const row = board?.find((entry) => matchesPlayer(userId, entry.id));
  if (!board || !row || typeof row.score !== "number") return undefined;
  const top = Math.max(
    0,
    ...board.map((e) => (typeof e.score === "number" ? e.score : 0)),
  );
  if (top <= 0) return undefined;
  const ahead = board.filter(
    (e) => (typeof e.score === "number" ? e.score : 0) > row.score,
  ).length;
  return 1 + ahead;
}

const MARK_ICON: Record<TileMarkIcon, typeof Check> = {
  check: Check,
  cross: X,
  crown: Crown,
  bolt: Zap,
  clock: Clock,
  skull: Skull,
};

interface GameTileOverlayProps {
  /** The tile's participant id. Omit on the local self tile to use the viewer's id. */
  userId?: string;
  compact?: boolean;
}

export default function GameTileOverlay({
  userId,
  compact = false,
}: GameTileOverlayProps) {
  const {
    publicState,
    view: privateView,
    userId: viewerId,
    isReadOnly,
    move,
  } = useGame();
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!publicState) return null;
  const tileUserId = userId ?? viewerId ?? null;
  if (!tileUserId) return null;

  // Only players in the active game get any treatment. Unknown or unmatched
  // ids render nothing (fail safe) rather than a blank-or-wrong badge.
  const isPlayer = publicState.players.some((player) =>
    matchesPlayer(tileUserId, player.id),
  );
  if (!isPlayer) return null;
  const viewerIsPlayer = Boolean(
    viewerId &&
      publicState.players.some((player) => matchesPlayer(viewerId, player.id)),
  );

  const accent = accentFor(publicState.gameId);
  const resolverArgs = {
    gameId: publicState.gameId,
    publicView: publicState.view,
    privateView,
    playerId: tileUserId,
    viewerId,
  };

  // Game-specific semantic state from the registered resolver, plus a universal
  // leaderboard rank merged on top.
  const resolved = getTileResolver(publicState.gameId)?.(resolverArgs) ?? null;
  const rank =
    publicState.hasLeaderboard && publicState.phase !== "lobby"
      ? rankFromScoreboard(publicState.view, tileUserId)
      : undefined;

  const state: PlayerTileState = { ...(resolved ?? {}) };
  if (rank !== undefined) state.rank = rank;
  const adornment =
    Object.keys(state).length > 0 ? resolveTileAdornment(state, accent) : null;

  // The interactive layer: while the game says this tile is a valid target for
  // the viewer, tapping it sends the move (tap a face to vote). Read-only
  // viewers and non-players never get it.
  const action =
    !isReadOnly && viewerIsPlayer && !publicState.finished
      ? (getTileAction(publicState.gameId)?.(resolverArgs) ?? null)
      : null;

  if (!adornment && !action) return null;

  const centerMark =
    adornment?.mark && adornment.mark.emphasis === "center" ? adornment.mark : null;
  const cornerMark =
    adornment?.mark && adornment.mark.emphasis !== "center" ? adornment.mark : null;
  const badge = adornment?.badge;

  const CenterIcon = centerMark ? MARK_ICON[centerMark.icon] : null;
  const CornerIcon = cornerMark ? MARK_ICON[cornerMark.icon] : null;

  // The bottom-right chip merges a corner mark and the badge into one pill. It
  // fills with the accent for accent-toned content, otherwise a neutral dark
  // chip that mirrors the tile's name label.
  const showChip = Boolean(cornerMark || badge);
  const chipIsAccent =
    badge?.tone === "accent" || (!badge && cornerMark?.tone === "accent");
  const badgeTextColor =
    !badge || chipIsAccent || badge.tone === "neutral"
      ? undefined
      : resolveTileToneColor(badge.tone, accent);

  const tileName =
    publicState.players.find((player) => matchesPlayer(tileUserId, player.id))
      ?.name ?? "player";

  const handleAction = () => {
    if (!action || busy) return;
    setBusy(true);
    void move(action.type, action.payload).finally(() => setBusy(false));
  };

  return (
    // rounded-[inherit] here is load bearing: children inherit their radius
    // from THIS element, so without it every ring and wash renders with square
    // corners inside the tile's rounded frame.
    <div className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit]">
      {adornment?.fill ? (
        <div
          className="absolute inset-0 rounded-[inherit]"
          style={{
            backgroundColor: adornment.fill.color,
            opacity: adornment.fill.opacity,
          }}
        />
      ) : null}
      {adornment?.dim ? (
        <div className="absolute inset-0 rounded-[inherit] bg-black/45" />
      ) : null}
      {adornment?.ring ? (
        <div
          className="absolute inset-0 rounded-[inherit]"
          style={{ boxShadow: `inset 0 0 0 2px ${adornment.ring.color}` }}
        />
      ) : null}

      {CenterIcon && centerMark ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className={`flex items-center justify-center rounded-full ${
              compact ? "h-9 w-9" : "h-12 w-12"
            }`}
            style={{ backgroundColor: resolveTileToneColor(centerMark.tone, accent) }}
          >
            <CenterIcon
              className={compact ? "h-5 w-5" : "h-6 w-6"}
              color="#fff"
              aria-hidden
            />
          </span>
        </div>
      ) : null}

      {showChip ? (
        <div
          className={`absolute bottom-3 right-3 flex items-center gap-1 rounded-full font-medium ${
            compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
          } ${
            chipIsAccent
              ? "text-white"
              : "border border-[#fafafa]/10 bg-black/70 text-[#fafafa]"
          }`}
          style={chipIsAccent ? { backgroundColor: accent } : undefined}
        >
          {CornerIcon && cornerMark ? (
            <CornerIcon
              className={compact ? "h-3 w-3" : "h-3.5 w-3.5"}
              color={chipIsAccent ? "#fff" : resolveTileToneColor(cornerMark.tone, accent)}
              aria-hidden
            />
          ) : null}
          {badge ? (
            <span style={badgeTextColor ? { color: badgeTextColor } : undefined}>
              {badge.text}
            </span>
          ) : null}
        </div>
      ) : null}

      {action ? (
        <button
          type="button"
          disabled={busy}
          aria-label={`${action.label} ${tileName}`}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onClick={(event) => {
            event.stopPropagation();
            handleAction();
          }}
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-[inherit] border-0 bg-transparent p-0"
        >
          {hovered && !busy ? (
            <>
              <span
                className="absolute inset-0 rounded-[inherit]"
                style={{ boxShadow: `inset 0 0 0 2px ${accent}` }}
              />
              <span className="absolute inset-0 flex items-center justify-center">
                <span
                  className={`rounded-full font-medium text-white ${
                    compact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1 text-xs"
                  }`}
                  style={{ backgroundColor: accent }}
                >
                  {action.label}
                </span>
              </span>
            </>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
