"use client";

import React, { useState } from "react";
import { useGame } from "@conclave/apps-sdk";
import { color, radius } from "@conclave/ui-tokens";
import {
  GAME_DOCK_HEADER_CLASS,
  GAME_DOCK_PANEL_CLASS,
  GAME_DOCK_TITLE_CLASS,
  GameDockCloseButton,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
} from "./gameUi";

type CatalogEntry = { id: string; name: string; description: string; minPlayers: number; maxPlayers: number };

/** One clean list row, used for both the launcher and the vote. Neutral by
 * default; a single coral accent marks selection / progress. */
function Row({
  name,
  sub,
  trailing,
  onClick,
  disabled,
  selected,
  fillRatio,
}: {
  name: string;
  sub: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
  fillRatio?: number;
}) {
  const interactive = Boolean(onClick) && !disabled;
  return (
    <button
      type="button"
      disabled={disabled || !onClick}
      onClick={onClick}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "12px 14px",
        borderRadius: radius.md,
        border: `1px solid ${selected ? color.accent : color.border}`,
        background: color.surfaceRaised,
        textAlign: "left",
        cursor: interactive ? "pointer" : "default",
        overflow: "hidden",
      }}
    >
      {typeof fillRatio === "number" ? (
        <span
          style={{
            position: "absolute",
            insetBlock: 0,
            left: 0,
            width: `${Math.max(0, Math.min(1, fillRatio)) * 100}%`,
            background: color.accentSoft,
            transition: "width 220ms ease",
          }}
        />
      ) : null}
      <span style={{ flex: 1, minWidth: 0, zIndex: 1 }}>
        <span style={{ display: "block", fontFamily: HEAD_FONT, fontSize: 15, color: color.text }}>{name}</span>
        <span style={{ display: "block", fontSize: 12.5, color: color.textMuted, marginTop: 1 }}>{sub}</span>
      </span>
      {trailing ? <span style={{ zIndex: 1, flexShrink: 0 }}>{trailing}</span> : null}
    </button>
  );
}

/**
 * The docked Games launcher. The host can start a game directly, or put the
 * choice to a room vote; everyone else votes or waits.
 */
export function GamesPanel({ onClose, rightOffset = 0 }: { onClose: () => void; rightOffset?: number }) {
  const { catalog, vote, isAdmin, userId, startGame, openVote, castVote, cancelVote } = useGame();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) setError(result.error ?? "Something went wrong");
    return result.success;
  };

  return (
    <aside
      className={GAME_DOCK_PANEL_CLASS}
      style={{ right: rightOffset, fontFamily: HEAD_FONT }}
      aria-label="Games"
    >
      <div className={GAME_DOCK_HEADER_CLASS}>
        <h2 className={GAME_DOCK_TITLE_CLASS}>
          {vote ? "Vote for a game" : "Play a game"}
        </h2>
        <GameDockCloseButton onClose={onClose} label="Close games" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {vote ? (
          <VoteView
            vote={vote}
            isAdmin={isAdmin}
            userId={userId}
            busy={busy}
            onCast={(id) => run(() => castVote(id))}
            onStart={(id) => run(() => startGame(id))}
            onCancel={() => run(() => cancelVote())}
          />
        ) : (
          <LauncherView
            catalog={catalog}
            isAdmin={isAdmin}
            busy={busy}
            onStart={(id) => run(() => startGame(id))}
            onOpenVote={() => run(() => openVote())}
          />
        )}
        {error ? <p style={{ fontSize: 12, color: color.danger, margin: "12px 0 0" }}>{error}</p> : null}
      </div>
    </aside>
  );
}

function LauncherView({
  catalog,
  isAdmin,
  busy,
  onStart,
  onOpenVote,
}: {
  catalog: CatalogEntry[];
  isAdmin: boolean;
  busy: boolean;
  onStart: (id: string) => void;
  onOpenVote: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 13, color: color.textMuted, margin: "0 0 4px", lineHeight: 1.5 }}>
        {isAdmin ? "Pick a game, or let the room vote." : "The host is picking a game."}
      </p>
      {catalog.map((entry) => (
        <Row
          key={entry.id}
          name={entry.name}
          sub={entry.description}
          disabled={!isAdmin || busy}
          onClick={isAdmin ? () => onStart(entry.id) : undefined}
          trailing={
            <span style={{ fontSize: 11, color: color.textFaint, whiteSpace: "nowrap" }}>
              {entry.minPlayers} to {entry.maxPlayers}
            </span>
          }
        />
      ))}
      {isAdmin ? (
        <div style={{ marginTop: 6 }}>
          <PrimaryButton full tone="neutral" disabled={busy} onClick={onOpenVote}>
            Put it to a vote
          </PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}

function VoteView({
  vote,
  isAdmin,
  userId,
  busy,
  onCast,
  onStart,
  onCancel,
}: {
  vote: { candidates: CatalogEntry[]; tally: Record<string, number>; votes: Record<string, string>; totalPlayers: number };
  isAdmin: boolean;
  userId: string | null;
  busy: boolean;
  onCast: (id: string) => void;
  onStart: (id: string) => void;
  onCancel: () => void;
}) {
  const voters = Object.keys(vote.votes).length;
  const maxVotes = Math.max(1, ...Object.values(vote.tally));
  const yourVote = userId ? vote.votes[userId] : undefined;
  let leaderId: string | null = null;
  let leaderVotes = -1;
  for (const entry of vote.candidates) {
    const v = vote.tally[entry.id] ?? 0;
    if (v > leaderVotes) {
      leaderVotes = v;
      leaderId = entry.id;
    }
  }
  const leaderName = vote.candidates.find((c) => c.id === leaderId)?.name ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 13, color: color.textMuted, margin: "0 0 4px" }}>
        {isAdmin ? "Vote too, then start the winner." : "Tap the game you want."}{" "}
        <span style={{ color: color.textFaint }}>
          {voters} of {vote.totalPlayers} voted
        </span>
      </p>
      {vote.candidates.map((entry) => {
        const count = vote.tally[entry.id] ?? 0;
        const mine = yourVote === entry.id;
        return (
          <Row
            key={entry.id}
            name={entry.name}
            sub={entry.description}
            disabled={busy}
            selected={mine}
            onClick={() => onCast(entry.id)}
            fillRatio={count / maxVotes}
            trailing={
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {mine ? <span style={{ fontSize: 11, color: color.accent }}>your pick</span> : null}
                <span style={{ fontFamily: HEAD_FONT, fontSize: 15, color: color.text, minWidth: 14, textAlign: "right" }}>{count}</span>
              </span>
            }
          />
        );
      })}
      {isAdmin ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <div style={{ flex: 1 }}>
            <PrimaryButton full disabled={busy || !leaderId} onClick={() => leaderId && onStart(leaderId)}>
              {leaderVotes > 0 && leaderName ? `Start ${leaderName}` : "Start the leader"}
            </PrimaryButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
