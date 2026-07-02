"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useGame } from "@conclave/apps-sdk";
import type { GameConfig, GameOptionSpec } from "@conclave/apps-sdk";
import { color, radius } from "@conclave/ui-tokens";
import {
  GAME_DOCK_HEADER_CLASS,
  GAME_DOCK_PANEL_CLASS,
  GAME_DOCK_TITLE_CLASS,
  GameDockCloseButton,
  GameDockResizeHandle,
  GhostButton,
  HEAD_FONT,
  PrimaryButton,
} from "./gameUi";

type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  options: GameOptionSpec[];
  hasLeaderboard: boolean;
};

const ADD_GAME_DOCS_URL =
  "https://github.com/ACM-VIT/conclave/blob/main/packages/apps-sdk/docs/guides/add-a-game.md";
const CURRENT_TOPIC_PATTERN =
  /\b(latest|recent|current|news|today|this week|this month|this year|breaking|new)\b/i;
const GENERATION_STEP_MS = 2_200;

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
export function GamesPanel({
  onClose,
  rightOffset = 0,
  dockWidth,
  maxDockWidth,
  onDockWidthChange,
}: {
  onClose: () => void;
  rightOffset?: number;
  dockWidth?: number;
  maxDockWidth?: number;
  onDockWidthChange?: (width: number) => void;
}) {
  const {
    catalog,
    vote,
    isAdmin,
    isReadOnly,
    userId,
    startGame,
    openVote,
    castVote,
    cancelVote,
  } = useGame();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<CatalogEntry | null>(null);

  const run = async (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) setError(result.error ?? "Something went wrong");
    return result.success;
  };

  const pick = (entry: CatalogEntry) => {
    setError(null);
    if (entry.options.length > 0) setConfiguring(entry);
    else void run(() => startGame(entry.id));
  };

  const title = vote ? "Vote for a game" : configuring ? configuring.name : "Play a game";

  return (
    <aside
      className={GAME_DOCK_PANEL_CLASS}
      style={{ right: rightOffset, width: dockWidth, fontFamily: HEAD_FONT }}
      aria-label="Games"
    >
      <GameDockResizeHandle
        width={dockWidth}
        maxWidth={maxDockWidth}
        onWidthChange={onDockWidthChange}
      />
      <div className={GAME_DOCK_HEADER_CLASS}>
        {configuring && !vote ? (
          <button
            type="button"
            onClick={() => setConfiguring(null)}
            aria-label="Back"
            className="-ml-1 mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
        <h2 className={GAME_DOCK_TITLE_CLASS}>{title}</h2>
        <GameDockCloseButton onClose={onClose} label="Close games" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {vote ? (
          <VoteView
            vote={vote}
            isAdmin={isAdmin}
            readOnly={isReadOnly}
            userId={userId}
            busy={busy}
            onCast={(id) => run(() => castVote(id))}
            onStart={(id) => run(() => startGame(id))}
            onCancel={() => run(() => cancelVote())}
          />
        ) : configuring ? (
          <GameConfigView
            key={configuring.id}
            entry={configuring}
            busy={busy}
            readOnly={isReadOnly}
            onStart={async (cfg) => {
              const ok = await run(() => startGame(configuring.id, cfg));
              if (ok) setConfiguring(null);
            }}
          />
        ) : (
          <LauncherView
            catalog={catalog}
            isAdmin={isAdmin}
            readOnly={isReadOnly}
            busy={busy}
            onPick={pick}
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
  readOnly,
  busy,
  onPick,
  onOpenVote,
}: {
  catalog: CatalogEntry[];
  isAdmin: boolean;
  readOnly: boolean;
  busy: boolean;
  onPick: (entry: CatalogEntry) => void;
  onOpenVote: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 13, color: color.textMuted, margin: "0 0 4px", lineHeight: 1.5 }}>
        {readOnly
          ? "Observer mode can watch games but cannot start one."
          : isAdmin
            ? "Pick a game, or let the room vote."
            : "The host is picking a game."}
      </p>
      {catalog.map((entry) => (
        <Row
          key={entry.id}
          name={entry.name}
          sub={entry.description}
          disabled={readOnly || !isAdmin || busy}
          onClick={!readOnly && isAdmin ? () => onPick(entry) : undefined}
          trailing={
            <span style={{ display: "flex", alignItems: "center", gap: 8, color: color.textFaint }}>
              <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                {entry.minPlayers} to {entry.maxPlayers}
              </span>
              {isAdmin && !readOnly ? (
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </span>
          }
        />
      ))}
      {isAdmin && !readOnly ? (
        <div style={{ marginTop: 6 }}>
          <PrimaryButton full tone="neutral" disabled={busy} onClick={onOpenVote}>
            Put it to a vote
          </PrimaryButton>
        </div>
      ) : null}
      <a
        href={ADD_GAME_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="group mt-2 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.045]"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-[#fafafa]">
            Add your own game
          </span>
          <span className="text-[12px] leading-snug text-[#a1a1aa]">
            Build on the Apps SDK
          </span>
        </span>
        <ExternalLink
          size={15}
          strokeWidth={1.75}
          className="shrink-0 text-[#71717a] transition-colors group-hover:text-[#fafafa]"
          aria-hidden="true"
        />
      </a>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  // Few options: a single equal-width segmented row. Many: wrap into chips so
  // long labels never clip in the narrow dock.
  const wrap = options.length > 4;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: wrap ? "wrap" : "nowrap",
        gap: 4,
        padding: 4,
        borderRadius: radius.md,
        background: color.surface,
        border: `1px solid ${color.border}`,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              flex: wrap ? "0 0 auto" : 1,
              padding: wrap ? "7px 13px" : "7px 6px",
              borderRadius: radius.sm,
              border: "none",
              background: active ? color.accent : "transparent",
              color: active ? color.text : color.textMuted,
              fontFamily: HEAD_FONT,
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
              cursor: "pointer",
              transition: "background 140ms ease, color 140ms ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function GameConfigView({
  entry,
  busy,
  readOnly,
  onStart,
}: {
  entry: CatalogEntry;
  busy: boolean;
  readOnly: boolean;
  onStart: (config: GameConfig) => void;
}) {
  const [config, setConfig] = useState<GameConfig>(() => {
    const initial: GameConfig = {};
    for (const opt of entry.options) initial[opt.id] = opt.default;
    return initial;
  });

  const setValue = (id: string, value: number | string) =>
    setConfig((prev) => ({ ...prev, [id]: value }));
  const [progressStep, setProgressStep] = useState(0);
  const topic = entry.options.reduce<string>((found, opt) => {
    if (found || opt.type !== "text") return found;
    const value = config[opt.id];
    return typeof value === "string" ? value.trim() : "";
  }, "");
  const isGenerating =
    busy &&
    entry.options.some((opt) => opt.type === "text");
  const progressLabels = useMemo(
    () => buildGenerationProgressLabels(entry, topic),
    [entry, topic],
  );
  useEffect(() => {
    if (!busy) {
      setProgressStep(0);
      return;
    }
    const timer = window.setInterval(() => {
      setProgressStep((step) => Math.min(step + 1, progressLabels.length - 1));
    }, GENERATION_STEP_MS);
    return () => window.clearInterval(timer);
  }, [busy, progressLabels.length]);
  const startLabel = busy
    ? isGenerating
      ? progressLabels[progressStep] ?? progressLabels[progressLabels.length - 1]
      : "Starting game"
    : `Start ${entry.name}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <p style={{ fontSize: 13, color: color.textMuted, margin: 0, lineHeight: 1.5 }}>
        {entry.description}.
      </p>

      {entry.options.map((opt) => (
        <div key={opt.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, color: color.text, fontFamily: HEAD_FONT }}>{opt.label}</span>
          {opt.type === "number" ? (
            <Segmented
              value={config[opt.id] as number}
              options={(opt.presets ?? [opt.min, Math.round((opt.min + opt.max) / 2), opt.max]).map((n) => ({
                value: n,
                label: `${n}${opt.suffix ? ` ${opt.suffix}` : ""}`,
              }))}
              onChange={(v) => setValue(opt.id, v)}
            />
          ) : opt.type === "select" ? (
            <Segmented
              value={config[opt.id] as string}
              options={opt.choices.map((c) => ({ value: c.value, label: c.label }))}
              onChange={(v) => setValue(opt.id, v)}
            />
          ) : (
            <input
              value={(config[opt.id] as string) ?? ""}
              maxLength={opt.maxLength}
              placeholder={opt.placeholder}
              onChange={(event) => setValue(opt.id, event.currentTarget.value)}
              style={{
                width: "100%",
                minWidth: 0,
                borderRadius: radius.md,
                border: `1px solid ${color.border}`,
                background: color.surface,
                color: color.text,
                fontFamily: HEAD_FONT,
                fontSize: 13,
                outline: "none",
                padding: "10px 12px",
              }}
            />
          )}
        </div>
      ))}

      <PrimaryButton full disabled={readOnly || busy} onClick={() => onStart(config)}>
        {busy ? (
          <span className="inline-flex min-w-0 items-center justify-center gap-2">
            <LoaderCircle
              size={15}
              strokeWidth={2}
              className="shrink-0 animate-spin"
              aria-hidden="true"
            />
            <span className="truncate" aria-live="polite">
              {startLabel}
            </span>
          </span>
        ) : (
          startLabel
        )}
      </PrimaryButton>
    </div>
  );
}

function buildGenerationProgressLabels(
  entry: CatalogEntry,
  topic: string,
): string[] {
  const contentName =
    entry.id === "trivia"
      ? "questions"
      : entry.id === "imposter"
        ? "word set"
        : "prompts";
  const labels = [`Generating ${contentName}`];
  if (CURRENT_TOPIC_PATTERN.test(topic)) {
    labels.push("Searching recent context");
  }
  if (entry.id === "trivia") {
    labels.push("Building answer choices");
  } else if (entry.id === "imposter") {
    labels.push("Balancing secret words");
  } else {
    labels.push("Polishing prompts");
  }
  labels.push(`Starting ${entry.name}`);
  return labels;
}

function VoteView({
  vote,
  isAdmin,
  readOnly,
  userId,
  busy,
  onCast,
  onStart,
  onCancel,
}: {
  vote: { candidates: CatalogEntry[]; tally: Record<string, number>; votes: Record<string, string>; totalPlayers: number };
  isAdmin: boolean;
  readOnly: boolean;
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
        {readOnly
          ? "Observer mode can watch this vote."
          : isAdmin
            ? "Vote too, then start the winner."
            : "Tap the game you want."}{" "}
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
            disabled={readOnly || busy}
            selected={mine}
            onClick={readOnly ? undefined : () => onCast(entry.id)}
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
      {isAdmin && !readOnly ? (
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
