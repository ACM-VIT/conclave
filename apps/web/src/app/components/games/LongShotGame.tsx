"use client";

import React, { useEffect, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import { GhostButton, HEAD_FONT, PrimaryButton, useRemaining, type GameViewProps } from "./gameUi";
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
  paused?: boolean;
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

const TIERS: Tier[] = ["obvious", "solid", "rare", "longShot"];

const TIER_LABEL: Record<Tier, string> = {
  obvious: "Obvious",
  solid: "Solid",
  rare: "Rare",
  longShot: "Long shot",
};

const GLOW: Record<Tier, string> = {
  obvious: "#9BE7DC",
  solid: "#39C3F2",
  rare: "#8C7BFF",
  longShot: "#FF74D4",
};

const ZONES = [
  { name: "Sunlight", from: 0, top: "#0F5C70", bottom: "#0B3B52" },
  { name: "Twilight", from: 200, top: "#0B3E5E", bottom: "#0A2440" },
  { name: "Midnight", from: 1000, top: "#0A2140", bottom: "#081227" },
  { name: "Abyss", from: 4000, top: "#08122A", bottom: "#050916" },
  { name: "Trench", from: 6000, top: "#060A1A", bottom: "#030409" },
] as const;

const MUTED = "rgba(220, 240, 255, 0.62)";
const LINE = "rgba(190, 235, 255, 0.14)";
const MISS = "#FF9C8F";

const zoneFor = (depth: number) => {
  let zone: (typeof ZONES)[number] = ZONES[0];
  for (const candidate of ZONES) if (depth >= candidate.from) zone = candidate;
  return zone;
};

const meters = (value: number) => `${Math.round(value).toLocaleString("en-US")} m`;

const shortMeters = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : `${Math.round(value)}`;

const nameOf = (id: string, name: string, userId: string | null) => (id === userId ? "You" : name);

const scatter = (index: number, salt: number) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const STYLES = `
@keyframes ls-rise { 0% { transform: translate(0, 0); opacity: 0 } 20% { opacity: .35 } 100% { transform: translate(var(--ls-drift, 6px), -620px); opacity: 0 } }
@keyframes ls-ray { 0%,100% { opacity: .5; transform: skewX(-18deg) } 50% { opacity: .85; transform: skewX(-14deg) translateX(12px) } }
@keyframes ls-sink { 0% { transform: translate(-50%, -120px); opacity: 0 } 60% { opacity: 1 } 82% { transform: translate(-50%, 3px) } 100% { transform: translate(-50%, 0) } }
@keyframes ls-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes ls-shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-5px) } 50% { transform: translateX(4px) } 75% { transform: translateX(-2px) } }
@keyframes ls-breathe { 0%,100% { transform: scale(var(--ls-air)) } 50% { transform: scale(calc(var(--ls-air) * 1.04)) } }
@keyframes ls-up { from { transform: translateY(10px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
@keyframes ls-burst { 0% { transform: translate(0,0) scale(.4); opacity: .9 } 100% { transform: translate(var(--ls-drift, 0px), -200px) scale(1); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .ls-scene, .ls-scene * { animation: none !important; transition: none !important } }
`;

function Ocean({ depth, children }: { depth: number; children: React.ReactNode }) {
  const zone = zoneFor(depth);
  return (
    <div
      className="ls-scene"
      style={{
        position: "relative",
        overflow: "hidden",
        isolation: "isolate",
        borderRadius: radius.lg,
        border: `1px solid ${LINE}`,
        background: `linear-gradient(180deg, ${zone.top} 0%, ${zone.bottom} 65%, #04060c 100%)`,
        transition: "background 1.2s ease",
        minHeight: "100%",
      }}
    >
      <style>{STYLES}</style>
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {depth < 1000
          ? [0, 1, 2].map((i) => (
              <span
                key={`r${i}`}
                style={{
                  position: "absolute",
                  top: -40,
                  left: `${12 + i * 30}%`,
                  width: 28 + i * 8,
                  height: "65%",
                  background: "linear-gradient(180deg, rgba(200,245,255,0.13), rgba(200,245,255,0))",
                  filter: "blur(6px)",
                  animation: `ls-ray ${8 + i * 2}s ease-in-out ${i}s infinite`,
                }}
              />
            ))
          : null}
        {[0, 1, 2, 3, 4].map((i) => {
          const size = 5 + scatter(i, 6) * 6;
          return (
            <span
              key={`b${i}`}
              style={
                {
                  position: "absolute",
                  bottom: -16,
                  left: `${10 + scatter(i, 7) * 80}%`,
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  border: "1px solid rgba(210, 245, 255, 0.6)",
                  "--ls-drift": `${(scatter(i, 8) - 0.5) * 30}px`,
                  animation: `ls-rise ${11 + scatter(i, 9) * 8}s ease-in ${-scatter(i, 10) * 14}s infinite`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
      <div style={{ position: "relative", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function Submersible({ light = "#FFE9A8", size = 1 }: { light?: string; size?: number }) {
  const beam = `ls-beam-${light.slice(1)}`;
  return (
    <svg width={52 * size} height={26 * size} viewBox="0 0 52 26" aria-hidden>
      <defs>
        <linearGradient id={beam} x1="0" x2="1">
          <stop offset="0" stopColor={light} stopOpacity="0.7" />
          <stop offset="1" stopColor={light} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points="31,13 52,3 52,23" fill={`url(#${beam})`} />
      <rect x="11" y="2" width="8" height="6" rx="2.5" fill={color.accent} />
      <rect x="4" y="6" width="28" height="15" rx="7.5" fill={color.accent} />
      <rect x="4" y="15" width="28" height="6" rx="3" fill="#000" opacity="0.18" />
      <circle cx="23" cy="13" r="4.2" fill="#0B2540" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.4" />
      <ellipse cx="2.5" cy="13.5" rx="1.6" ry="4.5" fill={color.accent} opacity="0.85" />
    </svg>
  );
}

function Depth({ value, size = 26 }: { value: number; size?: number }) {
  return (
    <span style={{ fontFamily: HEAD_FONT, fontSize: size, fontWeight: 500, color: color.text, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
      {meters(value)}
    </span>
  );
}

function SonarTimer({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const r = 24;
  const circ = 2 * Math.PI * r;
  const stroke = remainingMs <= 5000 ? color.accent : GLOW.solid;
  return (
    <div style={{ position: "relative", width: 60, height: 60, flexShrink: 0 }}>
      <svg width={60} height={60} viewBox="0 0 60 60">
        <circle cx={30} cy={30} r={r} fill="rgba(4, 12, 24, 0.5)" stroke={LINE} strokeWidth={3.5} />
        <circle
          cx={30}
          cy={30}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - ratio)}
          transform="rotate(-90 30 30)"
          style={{ transition: "stroke-dashoffset 200ms linear, stroke 300ms ease" }}
        />
      </svg>
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontSize: 18, color: color.text }}>
        {Math.ceil(remainingMs / 1000)}
      </span>
    </div>
  );
}

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: radius.md,
        background: "rgba(255, 255, 255, 0.06)",
        border: `1px solid ${LINE}`,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Prompt({ category, prompt, meta }: { category: string | null; prompt: string | null; meta?: string }) {
  return (
    <Panel style={{ padding: "13px 15px 15px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, fontFamily: HEAD_FONT }}>
        <span style={{ color: GLOW.obvious, ...ellipsis }}>{category}</span>
        {meta ? <span style={{ color: MUTED, flexShrink: 0 }}>{meta}</span> : null}
      </div>
      <div style={{ fontFamily: HEAD_FONT, fontSize: 21, color: color.text, marginTop: 4, lineHeight: 1.2, overflowWrap: "anywhere" }}>
        {prompt}
      </div>
    </Panel>
  );
}

function DiveColumn({ tier, points }: { tier?: Tier | null; points: Record<Tier, number> }) {
  const landed = tier ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {TIERS.map((t, index) => {
        const here = landed === t;
        return (
          <div
            key={t}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              height: here ? 44 : 32,
              padding: "0 12px",
              borderRadius: radius.sm,
              background: `rgba(0, 0, 0, ${0.12 + index * 0.09})`,
              border: `1px solid ${here ? GLOW[t] : "rgba(190,235,255,0.08)"}`,
              boxShadow: here ? `0 0 16px ${GLOW[t]}44` : undefined,
              opacity: landed && !here ? 0.4 : 1,
              transition: "all 400ms ease",
            }}
          >
            <span style={{ fontFamily: HEAD_FONT, fontSize: 12.5, color: color.text }}>{TIER_LABEL[t]}</span>
            <span style={{ fontFamily: HEAD_FONT, fontSize: 12.5, color: GLOW[t] }}>{meters(points[t])}</span>
            {here ? (
              <span style={{ position: "absolute", left: "50%", top: 9, animation: "ls-sink 900ms cubic-bezier(.3,.7,.3,1) both" }}>
                <Submersible light={GLOW[t]} size={0.85} />
              </span>
            ) : null}
          </div>
        );
      })}
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

  const focusIfFree = () => {
    const input = inputRef.current;
    if (!input) return;
    const active = document.activeElement;
    const free =
      !active ||
      active === document.body ||
      active === input ||
      Boolean(input.closest(".ls-scene")?.contains(active));
    if (free) input.focus();
  };

  useEffect(() => {
    if (autoFocus && !disabled) focusIfFree();
  }, [autoFocus, disabled]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(text)) setDraft("");
    } finally {
      setBusy(false);
      focusIfFree();
    }
  };

  return (
    <form
      key={shakeKey ?? "steady"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: "flex", gap: 8, animation: shakeKey ? "ls-shake 320ms ease" : undefined }}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value.slice(0, 48))}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Answer"
        autoComplete="off"
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: radius.pill,
          border: `1px solid ${disabled ? LINE : "rgba(190, 235, 255, 0.3)"}`,
          background: "rgba(3, 10, 20, 0.55)",
          color: color.text,
          padding: "11px 16px",
          fontSize: 15,
          fontFamily: "inherit",
          outline: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <PrimaryButton disabled={disabled || busy || !draft.trim()} onClick={() => void submit()}>
        {buttonLabel}
      </PrimaryButton>
    </form>
  );
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "miss" }) {
  if (!children) return null;
  return (
    <div style={{ fontSize: 12.5, color: tone === "miss" ? MISS : MUTED, textAlign: "center", minHeight: 16 }}>{children}</div>
  );
}

function Controls({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", justifyContent: "flex-end" }}>{children}</div>;
}

const missText = (miss: Miss) => (miss.reason === "used" ? `${miss.text} is taken` : "Not on the list");

function DiveChart({ rows, userId, winnerId }: { rows: { id: string; name: string; score: number }[]; userId: string | null; winnerId: string | null }) {
  const shown = rows.slice(0, 8);
  const floor = Math.max(1000, ...shown.map((row) => row.score)) * 1.12;
  const height = 150;
  const lines = ZONES.slice(1).filter((zone) => zone.from < floor);
  const rest = rows.slice(8);
  return (
    <>
      <div style={{ position: "relative", height: height + 48 }}>
        {lines.map((zone) => (
          <div key={zone.name} style={{ position: "absolute", left: 0, right: 0, top: (zone.from / floor) * height, borderTop: `1px dashed ${LINE}` }}>
            <span style={{ position: "absolute", left: 0, top: 3, fontSize: 9.5, color: "rgba(190,235,255,0.45)" }}>{zone.name}</span>
          </div>
        ))}
        <div style={{ position: "absolute", inset: 0, display: "flex", paddingLeft: 52 }}>
          {shown.map((row, index) => {
            const lead = winnerId ? row.id === winnerId : index === 0;
            const tone = lead ? GLOW.longShot : row.id === userId ? GLOW.solid : GLOW.obvious;
            return (
              <div key={row.id} style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 2, height: (row.score / floor) * height, background: `linear-gradient(180deg, rgba(255,255,255,0.12), ${tone})`, transition: "height 1.2s ease" }} />
                <span style={{ width: lead ? 18 : 12, height: 2, borderRadius: 1, background: tone, boxShadow: `0 0 8px ${tone}` }} />
                <span style={{ position: "absolute", top: height + 6, maxWidth: "100%", fontSize: 11, fontFamily: HEAD_FONT, color: row.id === userId ? color.text : MUTED, ...ellipsis }}>
                  {nameOf(row.id, row.name, userId)}
                </span>
                <span style={{ position: "absolute", top: height + 22, maxWidth: "100%", fontSize: 10.5, color: tone, fontVariantNumeric: "tabular-nums", ...ellipsis }}>
                  {shortMeters(row.score)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {rest.length > 0 ? (
        <Panel style={{ padding: "2px 12px" }}>
          {rest.map((row, index) => (
            <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: index ? `1px solid ${LINE}` : undefined }}>
              <span style={{ width: 18, fontSize: 12, color: MUTED, fontFamily: HEAD_FONT, flexShrink: 0 }}>{index + 9}</span>
              <span style={{ flex: 1, fontSize: 13, color: row.id === userId ? color.text : MUTED, ...ellipsis }}>{nameOf(row.id, row.name, userId)}</span>
              <span style={{ fontSize: 12.5, fontFamily: HEAD_FONT, color: color.text, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{meters(row.score)}</span>
            </div>
          ))}
        </Panel>
      ) : null}
    </>
  );
}

export default function LongShotGame({
  pub,
  me,
  isAdmin,
  readOnly = false,
  userId,
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
    if (!result.success) setError(result.error ?? "Try again");
    return result.success;
  };

  if (pub.phase === "lobby") {
    return (
      <Ocean depth={0}>
        <div style={{ textAlign: "center", padding: "28px 4px 8px" }}>
          <div style={{ display: "flex", justifyContent: "center", animation: "ls-float 3s ease-in-out infinite" }}>
            <Submersible size={1.5} />
          </div>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 28, color: color.text, lineHeight: 1.1, marginTop: 18 }}>
            {fuseMode ? "Last one under" : "How deep can you go?"}
          </div>
          <div style={{ fontSize: 13.5, color: MUTED, marginTop: 10 }}>
            {fuseMode ? "Take turns. Don't run out of air." : "Rarer answers sink you deeper."}
          </div>
        </div>
        <DiveColumn points={pub.tierPoints} />
        {host ? (
          <PrimaryButton full onClick={() => void send({ type: "start" })}>
            Dive
          </PrimaryButton>
        ) : (
          <Note>{readOnly ? "Watching" : "Waiting for the host"}</Note>
        )}
      </Ocean>
    );
  }

  if (pub.phase === "results") {
    const winner = fuseMode ? pub.scoreboard.find((row) => row.id === pub.winnerId) ?? null : pub.scoreboard[0] ?? null;
    return (
      <Ocean depth={pub.scoreboard[0]?.score ?? 0}>
        <div style={{ textAlign: "center", paddingTop: 6 }}>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 24, color: color.text }}>
            {winner ? `${nameOf(winner.id, winner.name, userId)} ${winner.id === userId ? "win" : "wins"}` : "Everyone surfaced"}
          </div>
          {winner ? <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>{meters(winner.score)}</div> : null}
        </div>
        <DiveChart rows={pub.scoreboard} userId={userId} winnerId={fuseMode ? pub.winnerId : null} />
        {pub.best.length > 0 ? (
          <Panel style={{ padding: "4px 12px" }}>
            {pub.best.slice(0, 6).map((row, index) => (
              <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: index ? `1px solid ${LINE}` : undefined }}>
                <span style={{ flex: 1, fontSize: 14, color: color.text, ...ellipsis, minWidth: "40%" }}>{row.answer}</span>
                <span style={{ fontSize: 12, color: MUTED, flexShrink: 1, ...ellipsis, maxWidth: "30%" }}>{nameOf(row.id, row.name, userId)}</span>
                <span style={{ fontSize: 12, fontFamily: HEAD_FONT, color: GLOW[row.tier], flexShrink: 0, minWidth: 64, textAlign: "right" }}>
                  {TIER_LABEL[row.tier]}
                </span>
              </div>
            ))}
          </Panel>
        ) : null}
      </Ocean>
    );
  }

  if (fuseMode) {
    const seats = (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {pub.seats.map((seat) => {
          const holding = pub.phase === "fuse" && seat.id === pub.turnPlayerId;
          const popped = pub.phase === "popped" && seat.id === pub.popped?.playerId;
          return (
            <span
              key={seat.id}
              style={{
                padding: "5px 11px",
                borderRadius: radius.pill,
                fontSize: 12.5,
                color: color.text,
                background: holding ? "rgba(57,195,242,0.16)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${holding ? GLOW.solid : popped ? color.accent : LINE}`,
                opacity: seat.out ? 0.35 : 1,
                textDecoration: seat.out ? "line-through" : undefined,
                maxWidth: 140,
                ...ellipsis,
              }}
            >
              {nameOf(seat.id, seat.name, userId)}
              {pub.maxLives > 1 && !seat.out ? <span style={{ color: MUTED }}> {seat.lives}</span> : null}
            </span>
          );
        })}
      </div>
    );

    if (pub.phase === "popped" && pub.popped) {
      const who = nameOf(pub.popped.playerId, pub.popped.name, userId);
      return (
        <Ocean depth={me.score}>
          <div style={{ position: "relative", textAlign: "center", padding: "64px 0 40px" }}>
            <div aria-hidden style={{ position: "absolute", left: "50%", bottom: 24 }}>
              {Array.from({ length: 12 }, (_, i) => {
                const size = 6 + scatter(i, 11) * 12;
                return (
                  <span
                    key={i}
                    style={
                      {
                        position: "absolute",
                        left: (scatter(i, 12) - 0.5) * 60,
                        width: size,
                        height: size,
                        borderRadius: "50%",
                        border: "1px solid rgba(220,245,255,0.75)",
                        "--ls-drift": `${(scatter(i, 13) - 0.5) * 150}px`,
                        animation: `ls-burst ${1.2 + scatter(i, 14)}s ease-out ${scatter(i, 15) * 0.4}s both`,
                      } as React.CSSProperties
                    }
                  />
                );
              })}
            </div>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 34, color: color.text }}>Out of air</div>
            <div style={{ fontSize: 14, color: MUTED, marginTop: 8 }}>{pub.popped.eliminated ? `${who} ${who === "You" ? "are" : "is"} out` : `${who} lost a life`}</div>
          </div>
          {seats}
          {host ? (
            <Controls>
              <GhostButton onClick={() => void send({ type: "next" })}>Next</GhostButton>
            </Controls>
          ) : null}
        </Ocean>
      );
    }

    const holder = pub.seats.find((seat) => seat.id === pub.turnPlayerId) ?? null;
    const myTurn = me.yourTurn && !readOnly;
    const missKey = pub.lastMiss && pub.lastMiss.playerId === userId ? pub.lastMiss.at : null;
    const air = pub.durationMs > 0 ? Math.max(0, Math.min(1, remaining / pub.durationMs)) : 0;
    const urgent = remaining <= 3000;
    return (
      <Ocean depth={me.score}>
        {seats}
        <Prompt category={pub.category} prompt={pub.prompt} meta={pub.usedCount ? `${pub.usedCount} found` : undefined} />

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ position: "relative", width: 72, height: 72, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span
              style={
                {
                  position: "absolute",
                  inset: 0,
                  borderRadius: "50%",
                  border: `1.5px solid ${urgent ? color.accent : "rgba(210,245,255,0.7)"}`,
                  background: `radial-gradient(circle at 32% 30%, rgba(255,255,255,0.4), ${urgent ? "rgba(249,95,74,0.22)" : "rgba(57,195,242,0.2)"} 55%, rgba(57,195,242,0.04))`,
                  "--ls-air": `${0.35 + air * 0.65}`,
                  animation: "ls-breathe 1.4s ease-in-out infinite",
                } as React.CSSProperties
              }
            />
            <span style={{ position: "relative", fontFamily: HEAD_FONT, fontSize: 17, color: color.text, fontVariantNumeric: "tabular-nums" }}>
              {(remaining / 1000).toFixed(1)}
            </span>
          </div>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 16, color: myTurn ? GLOW.solid : color.text, ...ellipsis }}>
            {pub.paused ? "Waiting for players" : myTurn ? "Your turn" : holder ? `${holder.name}'s turn` : ""}
          </div>
        </div>

        <AnswerInput
          key={pub.promptIndex}
          disabled={!myTurn}
          placeholder="Answer"
          buttonLabel="Pass"
          onSubmit={fire}
          shakeKey={missKey}
          autoFocus={myTurn}
        />
        <Note tone="miss">
          {error ?? (pub.lastMiss ? `${nameOf(pub.lastMiss.playerId, pub.lastMiss.name, userId)}: ${missText(pub.lastMiss)}` : null)}
        </Note>

        {pub.chain.length > 0 ? (
          <Panel style={{ padding: "2px 12px" }}>
            {[...pub.chain].reverse().slice(0, 6).map((link, index) => (
              <div
                key={`${link.answer}-${pub.chain.length - index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderTop: index ? `1px solid ${LINE}` : undefined,
                  opacity: Math.max(0.4, 1 - index * 0.14),
                  animation: index === 0 ? "ls-up 360ms ease-out" : undefined,
                }}
              >
                <span style={{ flex: 1, fontSize: 14, color: color.text, ...ellipsis, minWidth: "40%" }}>{link.answer}</span>
                <span style={{ fontSize: 12, color: MUTED, flexShrink: 1, ...ellipsis, maxWidth: "30%" }}>{nameOf(link.playerId, link.name, userId)}</span>
                <span style={{ fontSize: 12, fontFamily: HEAD_FONT, color: GLOW[link.tier], flexShrink: 0, minWidth: 64, textAlign: "right" }}>
                  {TIER_LABEL[link.tier]}
                </span>
              </div>
            ))}
          </Panel>
        ) : null}

        {host ? (
          <Controls>
            <GhostButton onClick={() => void send({ type: "skip" })}>Skip</GhostButton>
          </Controls>
        ) : null}
      </Ocean>
    );
  }

  if (pub.phase === "reveal") {
    return (
      <Ocean depth={me.score}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <Depth value={me.score} />
          {me.roundPoints > 0 ? <span style={{ fontFamily: HEAD_FONT, fontSize: 14, color: GLOW.solid }}>+{meters(me.roundPoints)}</span> : null}
        </div>
        <Prompt category={pub.category} prompt={pub.prompt} meta={`${pub.promptIndex + 1}/${pub.totalPrompts}`} />
        <Panel style={{ padding: "2px 12px" }}>
          {pub.results.map((row, index) => (
            <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: index ? `1px solid ${LINE}` : undefined }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: row.answer ? color.text : MUTED, ...ellipsis }}>{row.answer ?? "No answer"}</div>
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 1, ...ellipsis }}>
                  {nameOf(row.id, row.name, userId)}
                  {row.bonus > 0 ? " · only you" : row.shared ? " · jinx" : ""}
                </div>
              </div>
              <span style={{ fontFamily: HEAD_FONT, fontSize: 13, flexShrink: 0, color: row.tier ? GLOW[row.tier] : MUTED }}>
                {row.points > 0 ? `+${meters(row.points)}` : "0 m"}
              </span>
            </div>
          ))}
        </Panel>
        {pub.missedGems.length > 0 ? (
          <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            Missed: <span style={{ color: GLOW.longShot }}>{pub.missedGems.join(", ")}</span>
          </div>
        ) : null}
        {host ? (
          <Controls>
            <GhostButton onClick={() => void send({ type: "next" })}>Next</GhostButton>
          </Controls>
        ) : null}
      </Ocean>
    );
  }

  const missKey = me.lastMiss?.at ?? null;
  const missNote = me.lastMiss
    ? `${missText(me.lastMiss)} · ${me.triesLeft === 0 ? "no tries left" : `${me.triesLeft} ${me.triesLeft === 1 ? "try" : "tries"} left`}`
    : null;
  return (
    <Ocean depth={me.score}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Depth value={me.score} />
        <SonarTimer remainingMs={remaining} totalMs={pub.durationMs} />
      </div>
      <Prompt category={pub.category} prompt={pub.prompt} meta={`${pub.promptIndex + 1}/${pub.totalPrompts}`} />

      <DiveColumn tier={me.answer?.tier} points={pub.tierPoints} />
      {me.answer ? (
        <div style={{ textAlign: "center", fontFamily: HEAD_FONT, fontSize: 16, color: color.text, ...ellipsis }}>{me.answer.text}</div>
      ) : (
        <>
          <AnswerInput
          key={pub.promptIndex}
            disabled={readOnly || me.locked}
            placeholder="Answer"
            buttonLabel="Dive"
            onSubmit={fire}
            shakeKey={missKey}
            autoFocus
          />
          <Note tone="miss">{error ?? missNote}</Note>
        </>
      )}

      {host ? (
        <Controls>
          <GhostButton onClick={() => void send({ type: "skip" })}>Skip</GhostButton>
        </Controls>
      ) : null}
    </Ocean>
  );
}
