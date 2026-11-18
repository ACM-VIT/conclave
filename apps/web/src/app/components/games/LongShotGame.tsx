"use client";

import React, { useEffect, useRef, useState } from "react";
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
import { accentFor } from "./covers";
import type { LongShotMove } from "./moves";

type Tier = "obvious" | "solid" | "rare" | "longShot";

type RoundResult = {
  id: string;
  name: string;
  answer: string | null;
  tier: Tier | null;
  points: number;
  bonus: number;
  shared: boolean;
};

type Seat = { id: string; name: string; lives: number; out: boolean };
type ChainLink = { playerId: string; name: string; answer: string; tier: Tier; points: number };
type Miss = { text: string; reason: "unknown" | "used"; at: number };

type LongShotPublic = {
  mode: "classic" | "fuse";
  phase: "lobby" | "prompt" | "reveal" | "fuse" | "popped" | "results";
  serverNow: number;
  deadline: number | null;
  durationMs: number;
  promptIndex: number;
  totalPrompts: number;
  category: string | null;
  prompt: string | null;
  tierCounts: Record<Tier, number> | null;
  tierPoints: Record<Tier, number>;
  onlyYouBonus: number;
  maxTries: number;
  answeredCount: number;
  totalPlayers: number;
  results: RoundResult[];
  missedGems: string[];
  obviousPicks: string[];
  turnPlayerId: string | null;
  maxLives: number;
  seats: Seat[];
  chain: ChainLink[];
  usedCount: number;
  lastMiss: (Miss & { playerId: string; name: string }) | null;
  popped: { playerId: string; name: string; eliminated: boolean } | null;
  winnerId: string | null;
  survivorBonus: number;
  best: { id: string; name: string; answer: string; tier: Tier; prompt: string; points: number }[];
  scoreboard: { id: string; name: string; score: number }[];
};

type LongShotMe = {
  score: number;
  rank: number | null;
  answer: { text: string; tier: Tier; points: number } | null;
  misses: number;
  triesLeft: number;
  locked: boolean;
  lastMiss: Miss | null;
  roundPoints: number;
  roundBonus: number;
  shared: boolean;
  yourTurn: boolean;
  lives: number;
};

const GAME_ID = "long-shot";
const TIERS: Tier[] = ["obvious", "solid", "rare", "longShot"];

const TIER_LABEL: Record<Tier, string> = {
  obvious: "Obvious",
  solid: "Solid",
  rare: "Rare",
  longShot: "Long shot",
};

// A cool-to-hot ramp: the further the shot flies, the hotter it reads.
const TIER_COLOR: Record<Tier, string> = {
  obvious: "#8A8F98",
  solid: "#4FB3E8",
  rare: "#A98BF5",
  longShot: "#F5B544",
};

const KEYFRAMES = `
@keyframes ls-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-6px) } 40% { transform: translateX(5px) } 60% { transform: translateX(-3px) } 80% { transform: translateX(2px) } }
@keyframes ls-fly { from { left: 0%; opacity: .2 } to { opacity: 1 } }
@keyframes ls-spark { 0%,100% { opacity: 1; transform: translate(-50%,-50%) scale(1) } 50% { opacity: .55; transform: translate(-50%,-50%) scale(1.35) } }
@keyframes ls-pop { 0% { transform: scale(.6); opacity: 0 } 60% { transform: scale(1.08); opacity: 1 } 100% { transform: scale(1) } }
`;

function TierChip({ tier, small }: { tier: Tier; small?: boolean }) {
  const tone = TIER_COLOR[tier];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: small ? "1px 7px" : "2px 9px",
        borderRadius: radius.pill,
        border: `1px solid ${tone}`,
        color: tone,
        fontFamily: HEAD_FONT,
        fontSize: small ? 10.5 : 11.5,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

/**
 * The range: four bands from obvious (near) to long shot (far). When a tier is
 * given, a marker flies out and lands in that band.
 */
function Range({
  tier,
  counts,
  points,
}: {
  tier?: Tier | null;
  counts?: Record<Tier, number> | null;
  points: Record<Tier, number>;
}) {
  const landed = tier ? TIERS.indexOf(tier) : -1;
  return (
    <div>
      <div style={{ position: "relative", display: "flex", gap: 3, height: 10 }}>
        {TIERS.map((t, index) => (
          <div
            key={t}
            style={{
              flex: 1,
              borderRadius: radius.pill,
              background: TIER_COLOR[t],
              opacity: landed === -1 ? 0.28 + index * 0.1 : landed === index ? 1 : 0.18,
              transition: "opacity 300ms ease",
            }}
          />
        ))}
        {landed >= 0 ? (
          <span
            key={tier}
            style={{
              position: "absolute",
              top: "50%",
              left: `${(landed + 0.5) * 25}%`,
              width: 16,
              height: 16,
              borderRadius: radius.pill,
              background: color.text,
              border: `3px solid ${TIER_COLOR[tier as Tier]}`,
              transform: "translate(-50%, -50%)",
              animation: "ls-fly 520ms cubic-bezier(.2,.8,.2,1)",
              boxShadow: `0 0 14px ${TIER_COLOR[tier as Tier]}`,
            }}
          />
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
        {TIERS.map((t, index) => (
          <div key={t} style={{ flex: 1, textAlign: "center", opacity: landed === -1 || landed === index ? 1 : 0.5 }}>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 11, color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div style={{ fontSize: 10, color: color.textFaint, marginTop: 1 }}>
              {points[t]} pts{counts ? ` · ${counts[t]}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptCard({ category, prompt, sub }: { category: string | null; prompt: string | null; sub?: string }) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: radius.lg,
        border: `1px solid ${color.border}`,
        background: `linear-gradient(135deg, ${color.surfaceRaised} 0%, ${color.surface} 100%)`,
        padding: "16px 16px 18px",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: -40,
          top: -40,
          width: 140,
          height: 140,
          borderRadius: "50%",
          background: accentFor(GAME_ID),
          opacity: 0.12,
          filter: "blur(30px)",
          pointerEvents: "none",
        }}
      />
      <p style={{ position: "relative", fontSize: 12, color: accentFor(GAME_ID), margin: 0, fontFamily: HEAD_FONT }}>
        {category}
        {sub ? <span style={{ color: color.textFaint }}> · {sub}</span> : null}
      </p>
      <p style={{ position: "relative", fontFamily: HEAD_FONT, fontSize: 22, color: color.text, margin: "6px 0 0", lineHeight: 1.2 }}>
        {prompt}
      </p>
    </div>
  );
}

function AnswerInput({
  disabled,
  placeholder,
  buttonLabel,
  onSubmit,
  shakeKey,
  autoFocus,
}: {
  disabled: boolean;
  placeholder: string;
  buttonLabel: string;
  onSubmit: (text: string) => Promise<boolean>;
  shakeKey: number | null;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus();
  }, [autoFocus, disabled]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled || busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setDraft("");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <form
      key={shakeKey ?? "steady"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{
        display: "flex",
        gap: 8,
        animation: shakeKey ? "ls-shake 360ms ease" : undefined,
      }}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value.slice(0, 48))}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Your answer"
        autoComplete="off"
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: radius.pill,
          border: `1.5px solid ${disabled ? color.border : color.borderStrong}`,
          background: color.surface,
          color: color.text,
          padding: "11px 16px",
          fontSize: 15,
          fontFamily: "inherit",
          outline: "none",
          opacity: disabled ? 0.55 : 1,
        }}
      />
      <PrimaryButton disabled={disabled || busy || !draft.trim()} onClick={() => void submit()}>
        {buttonLabel}
      </PrimaryButton>
    </form>
  );
}

function TriesDots({ left, max }: { left: number; max: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 4 }} aria-label={`${left} tries left`}>
      {Array.from({ length: max }, (_, index) => (
        <span
          key={index}
          style={{
            width: 7,
            height: 7,
            borderRadius: radius.pill,
            background: index < left ? accentFor(GAME_ID) : color.border,
          }}
        />
      ))}
    </span>
  );
}

function Lives({ lives, max }: { lives: number; max: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }} aria-label={`${lives} lives`}>
      {Array.from({ length: max }, (_, index) => (
        <span
          key={index}
          style={{
            width: 6,
            height: 6,
            borderRadius: radius.pill,
            background: index < lives ? TIER_COLOR.longShot : color.border,
          }}
        />
      ))}
    </span>
  );
}

/** The burning fuse: a line that shortens toward a flickering spark. */
function Fuse({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const urgent = remainingMs <= 3000;
  const spark = urgent ? color.danger : TIER_COLOR.longShot;
  return (
    <div style={{ position: "relative", height: 18, display: "flex", alignItems: "center" }}>
      <div style={{ position: "absolute", left: 0, right: 0, height: 4, borderRadius: radius.pill, background: color.border }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          width: `${ratio * 100}%`,
          height: 4,
          borderRadius: radius.pill,
          background: `linear-gradient(90deg, ${color.borderStrong}, ${spark})`,
          transition: "width 200ms linear",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: `${ratio * 100}%`,
          top: "50%",
          width: 12,
          height: 12,
          borderRadius: radius.pill,
          background: spark,
          boxShadow: `0 0 12px ${spark}, 0 0 4px #fff`,
          animation: "ls-spark 420ms ease-in-out infinite",
        }}
      />
      <span
        style={{
          position: "absolute",
          right: 0,
          top: -14,
          fontFamily: HEAD_FONT,
          fontSize: 12,
          color: urgent ? color.danger : color.textMuted,
        }}
      >
        {(remainingMs / 1000).toFixed(1)}s
      </span>
    </div>
  );
}

function missText(miss: Miss, triesLeft?: number): string {
  const base =
    miss.reason === "used"
      ? `${miss.text} was already said`
      : `“${miss.text}” isn't on the list`;
  if (typeof triesLeft === "number") {
    return `${base}. ${triesLeft === 0 ? "No tries left." : `${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`}`;
  }
  return base;
}

function Scoreboard({ rows, userId, winnerId }: { rows: { id: string; name: string; score: number }[]; userId: string | null; winnerId?: string | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((entry, index) => {
        const top = winnerId ? entry.id === winnerId : index === 0;
        return (
          <div
            key={entry.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: radius.md,
              background: top ? color.accentSoft : color.surfaceRaised,
              border: entry.id === userId ? `1px solid ${color.borderStrong}` : "1px solid transparent",
            }}
          >
            <span style={{ width: 18, color: color.textFaint, fontSize: 13, fontFamily: HEAD_FONT }}>{index + 1}</span>
            <span style={{ flex: 1, color: color.text, fontSize: 14 }}>
              {entry.name}
              {entry.id === userId ? <span style={{ color: color.textFaint }}> (you)</span> : null}
            </span>
            <span style={{ color: color.text, fontFamily: HEAD_FONT, fontWeight: 500 }}>{entry.score}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function LongShotGame({
  pub,
  me,
  players,
  userId,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<LongShotPublic, LongShotMe>) {
  const send = createTypedMove<LongShotMove>(move);
  const remaining = useRemaining(pub.deadline, pub.serverNow);
  const [error, setError] = useState<string | null>(null);
  const host = isAdmin && !readOnly;
  const fuseMode = pub.mode === "fuse";

  const fire = async (text: string): Promise<boolean> => {
    setError(null);
    const result = await send({ type: "answer", text });
    if (!result.success) setError(result.error ?? "Couldn't send that");
    return result.success;
  };

  const shell = (children: React.ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{KEYFRAMES}</style>
      {children}
    </div>
  );

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId={GAME_ID}
        title={fuseMode ? "Pass the fuse" : `${pub.totalPrompts} prompts, one shot each`}
        blurb={
          fuseMode
            ? "Take turns naming an answer nobody has said yet before the fuse burns out. Rare answers score more. Last one standing wins."
            : "Everyone answers the same prompt. Obvious answers barely score; the rarer your answer, the further it flies. Say something nobody else did for a bonus."
        }
        players={players}
        userId={userId}
        isAdmin={isAdmin}
        readOnly={readOnly}
        startLabel={fuseMode ? "Light the fuse" : "Start"}
        onStart={() => send({ type: "start" })}
      />
    );
  }

  if (pub.phase === "results") {
    const winner = fuseMode
      ? pub.scoreboard.find((row) => row.id === pub.winnerId) ?? null
      : pub.scoreboard[0] ?? null;
    return shell(
      <>
        <div style={{ textAlign: "center", animation: "ls-pop 420ms ease" }}>
          <p style={{ fontFamily: HEAD_FONT, fontSize: 13, color: accentFor(GAME_ID), margin: 0 }}>
            {fuseMode ? "Last one standing" : "Final distance"}
          </p>
          <p style={{ fontFamily: HEAD_FONT, fontSize: 24, color: color.text, margin: "6px 0 0" }}>
            {winner ? `${winner.name} wins` : "Everyone popped"}
          </p>
          {fuseMode && winner ? (
            <p style={{ fontSize: 12, color: color.textMuted, margin: "4px 0 0" }}>
              +{pub.survivorBonus} survivor bonus
            </p>
          ) : null}
        </div>
        <Scoreboard rows={pub.scoreboard} userId={userId} winnerId={fuseMode ? pub.winnerId : null} />
        {pub.best.length > 0 ? (
          <div>
            <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "4px 0 8px" }}>
              Longest shots
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {pub.best.slice(0, 6).map((row) => (
                <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ color: color.textMuted, minWidth: 0, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name}
                  </span>
                  <span style={{ color: color.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.answer}
                  </span>
                  <TierChip tier={row.tier} small />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </>,
    );
  }

  /* ---- Pass the fuse ---- */

  if (fuseMode) {
    if (pub.phase === "popped" && pub.popped) {
      const you = pub.popped.playerId === userId;
      return shell(
        <div style={{ textAlign: "center", padding: "28px 0" }}>
          <p
            style={{
              fontFamily: HEAD_FONT,
              fontSize: 44,
              color: color.danger,
              margin: 0,
              animation: "ls-pop 420ms ease",
            }}
          >
            Pop!
          </p>
          <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "10px 0 0" }}>
            {you ? "You" : pub.popped.name} {pub.popped.eliminated ? (you ? "are out" : "is out") : `lost a life`}
          </p>
          <p style={{ fontSize: 12, color: color.textMuted, margin: "8px 0 0" }}>
            {pub.usedCount} answers said for “{pub.prompt}”
          </p>
          {host ? (
            <div style={{ marginTop: 18 }}>
              <GhostButton onClick={() => send({ type: "next" })}>Next prompt</GhostButton>
            </div>
          ) : null}
        </div>,
      );
    }

    const holder = pub.seats.find((seat) => seat.id === pub.turnPlayerId) ?? null;
    const myTurn = me.yourTurn && !readOnly;
    const missKey = pub.lastMiss && pub.lastMiss.playerId === userId ? pub.lastMiss.at : null;
    return shell(
      <>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {pub.seats.map((seat) => {
            const holding = seat.id === pub.turnPlayerId;
            return (
              <div
                key={seat.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 10px",
                  borderRadius: radius.pill,
                  border: `1px solid ${holding ? TIER_COLOR.longShot : color.border}`,
                  background: holding ? "rgba(245, 181, 68, 0.12)" : color.surfaceRaised,
                  opacity: seat.out ? 0.4 : 1,
                  textDecoration: seat.out ? "line-through" : undefined,
                }}
              >
                <span style={{ fontSize: 12, color: color.text }}>
                  {seat.id === userId ? "You" : seat.name}
                </span>
                <Lives lives={seat.lives} max={pub.maxLives} />
              </div>
            );
          })}
        </div>

        <PromptCard category={pub.category} prompt={pub.prompt} sub={`${pub.usedCount} said`} />

        <div>
          <p style={{ fontSize: 13, color: myTurn ? TIER_COLOR.longShot : color.textMuted, margin: "0 0 8px", fontFamily: HEAD_FONT }}>
            {myTurn ? "You have the fuse. Quick!" : holder ? `${holder.name} has the fuse` : "Waiting"}
          </p>
          <Fuse remainingMs={remaining} totalMs={pub.durationMs} />
        </div>

        <AnswerInput
          disabled={!myTurn}
          placeholder={myTurn ? "Name one nobody's said" : "Wait for the fuse"}
          buttonLabel="Pass"
          onSubmit={fire}
          shakeKey={missKey}
          autoFocus={myTurn}
        />

        <div style={{ minHeight: 18, fontSize: 12, color: color.danger }}>
          {error ??
            (pub.lastMiss
              ? `${pub.lastMiss.playerId === userId ? "You" : pub.lastMiss.name}: ${missText(pub.lastMiss)}`
              : null)}
        </div>

        {pub.chain.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {[...pub.chain].reverse().map((link, index) => (
              <div
                key={`${link.answer}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: radius.md,
                  background: index === 0 ? color.surfaceRaised : "transparent",
                  opacity: Math.max(0.35, 1 - index * 0.12),
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {link.answer}
                </span>
                <span style={{ fontSize: 11, color: color.textFaint }}>{link.playerId === userId ? "you" : link.name}</span>
                <TierChip tier={link.tier} small />
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, color: color.text, fontFamily: HEAD_FONT }}>
            {me.score} pts{me.rank ? ` · #${me.rank}` : ""}
          </span>
          {host ? <GhostButton onClick={() => send({ type: "skip" })}>New prompt</GhostButton> : null}
        </div>
      </>,
    );
  }

  /* ---- Everyone at once ---- */

  if (pub.phase === "reveal") {
    return shell(
      <>
        <PromptCard
          category={pub.category}
          prompt={pub.prompt}
          sub={`Prompt ${pub.promptIndex + 1} of ${pub.totalPrompts}`}
        />
        {me.answer ? (
          <div style={{ padding: "2px 2px 0" }}>
            <Range tier={me.answer.tier} points={pub.tierPoints} />
            <p style={{ fontSize: 13, color: color.text, margin: "10px 0 0", textAlign: "center" }}>
              <span style={{ fontFamily: HEAD_FONT }}>{me.answer.text}</span>
              <span style={{ color: color.textMuted }}>
                {" "}
                +{me.roundPoints}
                {me.roundBonus > 0 ? " · only you said it" : me.shared ? " · jinx, someone else said it too" : ""}
              </span>
            </p>
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {pub.results.map((row) => (
            <div
              key={row.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "9px 12px",
                borderRadius: radius.md,
                background: color.surfaceRaised,
                border: row.id === userId ? `1px solid ${color.borderStrong}` : "1px solid transparent",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: row.answer ? color.text : color.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.answer ?? "Missed"}
                </div>
                <div style={{ fontSize: 11, color: color.textFaint, marginTop: 1 }}>
                  {row.id === userId ? "You" : row.name}
                  {row.bonus > 0 ? ` · only you +${row.bonus}` : row.shared ? " · jinx" : ""}
                </div>
              </div>
              {row.tier ? <TierChip tier={row.tier} small /> : null}
              <span style={{ width: 40, textAlign: "right", fontFamily: HEAD_FONT, fontSize: 14, color: row.points > 0 ? color.text : color.textFaint }}>
                +{row.points}
              </span>
            </div>
          ))}
        </div>
        {pub.missedGems.length > 0 ? (
          <div>
            <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 6px" }}>
              Long shots nobody tried
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pub.missedGems.map((gem) => (
                <span key={gem} style={{ fontSize: 12, color: TIER_COLOR.longShot, padding: "3px 9px", borderRadius: radius.pill, background: "rgba(245, 181, 68, 0.1)" }}>
                  {gem}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {pub.obviousPicks.length > 0 ? (
          <p style={{ fontSize: 12, color: color.textFaint, margin: 0 }}>
            Obvious picks: {pub.obviousPicks.join(", ")}
          </p>
        ) : null}
        {host ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <GhostButton onClick={() => send({ type: "next" })}>Next</GhostButton>
          </div>
        ) : null}
      </>,
    );
  }

  // prompt
  const missKey = me.lastMiss?.at ?? null;
  return shell(
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PromptCard
            category={pub.category}
            prompt={pub.prompt}
            sub={`${pub.promptIndex + 1} of ${pub.totalPrompts}`}
          />
        </div>
        <CountdownRing
          remainingMs={remaining}
          totalMs={pub.durationMs}
          label={`${pub.answeredCount}/${pub.totalPlayers}`}
        />
      </div>

      {me.answer ? (
        <div style={{ padding: "4px 2px" }}>
          <Range tier={me.answer.tier} points={pub.tierPoints} />
          <p style={{ fontSize: 13, color: color.text, margin: "12px 0 0", textAlign: "center" }}>
            <span style={{ fontFamily: HEAD_FONT }}>{me.answer.text}</span>
            <span style={{ color: color.textMuted }}> · {TIER_LABEL[me.answer.tier]}, {me.answer.points} pts</span>
          </p>
          <p style={{ fontSize: 12, color: color.textFaint, margin: "6px 0 0", textAlign: "center" }}>
            Locked in. Nobody else picks it and you get +{pub.onlyYouBonus}.
          </p>
        </div>
      ) : (
        <>
          <Range counts={pub.tierCounts} points={pub.tierPoints} />
          <AnswerInput
            disabled={readOnly || me.locked}
            placeholder={me.locked ? "Out of tries" : "Go for a long shot"}
            buttonLabel="Shoot"
            onSubmit={fire}
            shakeKey={missKey}
            autoFocus
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 18 }}>
            <span style={{ fontSize: 12, color: me.lastMiss || error ? color.danger : color.textMuted }}>
              {error ?? (me.lastMiss ? missText(me.lastMiss, me.triesLeft) : readOnly ? "Watching only" : "Typos are forgiven, made-up answers aren't")}
            </span>
            {!readOnly ? <TriesDots left={me.triesLeft} max={pub.maxTries} /> : null}
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: color.text, fontFamily: HEAD_FONT }}>
          {me.score} pts{me.rank ? ` · #${me.rank}` : ""}
        </span>
        {host ? <GhostButton onClick={() => send({ type: "skip" })}>Reveal now</GhostButton> : null}
      </div>
    </>,
  );
}
