"use client";

import React, { useEffect, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import { createTypedMove } from "@conclave/apps-sdk";
import { GhostButton, HEAD_FONT, PrimaryButton, useRemaining, type GameViewProps } from "./gameUi";
import type { LongShotMove } from "./moves";

/*
 * Long Shot, dressed as a dive. Score is depth: every accepted answer sinks
 * you by its tier's meters, so the rarer the answer, the deeper the water
 * around you gets. The scene darkens through the real ocean zones (sunlight,
 * twilight, midnight, abyss, hadal) while the controls stay Conclave: the same
 * type, buttons, and coral accent, which also paints the little submersible.
 */

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

const TIERS: Tier[] = ["obvious", "solid", "rare", "longShot"];

const TIER_LABEL: Record<Tier, string> = {
  obvious: "Obvious",
  solid: "Solid",
  rare: "Rare",
  longShot: "Long shot",
};

/** Bioluminescence: the deeper the tier, the stranger the glow. */
const GLOW: Record<Tier, string> = {
  obvious: "#9BE7DC",
  solid: "#39C3F2",
  rare: "#8C7BFF",
  longShot: "#FF74D4",
};

/** Real ocean zones by depth. The scene's water follows the deepest one reached. */
const ZONES = [
  { name: "Sunlight zone", from: 0, top: "#0F5C70", bottom: "#0B3B52" },
  { name: "Twilight zone", from: 200, top: "#0B3E5E", bottom: "#0A2440" },
  { name: "Midnight zone", from: 1000, top: "#0A2140", bottom: "#081227" },
  { name: "Abyss", from: 4000, top: "#08122A", bottom: "#050916" },
  { name: "Hadal trench", from: 6000, top: "#060A1A", bottom: "#030409" },
] as const;

const SUB_HULL = color.accent;

const zoneFor = (depth: number) => {
  let zone: (typeof ZONES)[number] = ZONES[0];
  for (const candidate of ZONES) if (depth >= candidate.from) zone = candidate;
  return zone;
};

const meters = (value: number) => `${Math.round(value).toLocaleString("en-US")} m`;

/** Deterministic scatter so server and client render the same particles. */
const scatter = (index: number, salt: number) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const STYLES = `
.ls-scene { --ls-glass: rgba(255,255,255,0.06); --ls-line: rgba(190,235,255,0.16); }
@keyframes ls-snow { from { transform: translateY(-12px) } to { transform: translateY(560px) } }
@keyframes ls-rise { 0% { transform: translate(0, 0) scale(.6); opacity: 0 } 15% { opacity: .9 } 100% { transform: translate(var(--ls-drift, 6px), -560px) scale(1); opacity: 0 } }
@keyframes ls-ray { 0%,100% { opacity: .55; transform: skewX(-18deg) translateX(0) } 50% { opacity: .9; transform: skewX(-14deg) translateX(14px) } }
@keyframes ls-sink { 0% { transform: translate(-50%, -140px) rotate(-8deg); opacity: 0 } 60% { opacity: 1 } 80% { transform: translate(-50%, 4px) rotate(3deg) } 100% { transform: translate(-50%, 0) rotate(0) } }
@keyframes ls-bob { 0%,100% { transform: translate(-50%, 0) } 50% { transform: translate(-50%, -3px) } }
@keyframes ls-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
@keyframes ls-ping { from { r: 30; opacity: .55 } to { r: 44; opacity: 0 } }
@keyframes ls-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-6px) } 40% { transform: translateX(5px) } 60% { transform: translateX(-3px) } 80% { transform: translateX(2px) } }
@keyframes ls-breathe { 0%,100% { transform: scale(var(--ls-air)) } 50% { transform: scale(calc(var(--ls-air) * 1.04)) } }
@keyframes ls-up { from { transform: translateY(18px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
@keyframes ls-burst { 0% { transform: translate(0,0) scale(.4); opacity: 1 } 100% { transform: translate(var(--ls-drift, 0px), -220px) scale(1.1); opacity: 0 } }
@keyframes ls-glow { 0%,100% { box-shadow: 0 0 10px var(--ls-c), inset 0 0 6px var(--ls-c) } 50% { box-shadow: 0 0 18px var(--ls-c), inset 0 0 10px var(--ls-c) } }
@media (prefers-reduced-motion: reduce) { .ls-scene *, .ls-scene { animation: none !important; transition: none !important } }
`;

/* ---------------------------------------------------------------- scene */

function Ocean({ depth, children, rays }: { depth: number; children: React.ReactNode; rays?: boolean }) {
  const zone = zoneFor(depth);
  const sunlit = rays ?? depth < 1000;
  return (
    <div
      className="ls-scene"
      style={{
        position: "relative",
        overflow: "hidden",
        isolation: "isolate",
        borderRadius: radius.lg,
        border: "1px solid rgba(160, 225, 255, 0.12)",
        background: `linear-gradient(180deg, ${zone.top} 0%, ${zone.bottom} 62%, #04060c 100%)`,
        transition: "background 1.2s ease",
        minHeight: "100%",
      }}
    >
      <style>{STYLES}</style>
      {sunlit ? (
        <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }}>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                top: -40,
                left: `${8 + i * 24}%`,
                width: 26 + i * 6,
                height: "70%",
                background: "linear-gradient(180deg, rgba(200,245,255,0.16), rgba(200,245,255,0))",
                filter: "blur(6px)",
                animation: `ls-ray ${7 + i * 1.5}s ease-in-out ${i * 0.8}s infinite`,
              }}
            />
          ))}
        </div>
      ) : null}
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        {Array.from({ length: 22 }, (_, i) => (
          <span
            key={`s${i}`}
            style={{
              position: "absolute",
              top: `${-10 - scatter(i, 1) * 90}%`,
              left: `${scatter(i, 2) * 100}%`,
              width: 1.5 + scatter(i, 3) * 2,
              height: 1.5 + scatter(i, 3) * 2,
              borderRadius: "50%",
              background: "rgba(225, 245, 255, 0.5)",
              animation: `ls-snow ${14 + scatter(i, 4) * 14}s linear ${-scatter(i, 5) * 20}s infinite`,
            }}
          />
        ))}
        {Array.from({ length: 9 }, (_, i) => {
          const size = 4 + scatter(i, 6) * 7;
          return (
            <span
              key={`b${i}`}
              style={
                {
                  position: "absolute",
                  bottom: -16,
                  left: `${scatter(i, 7) * 100}%`,
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  border: "1px solid rgba(210, 245, 255, 0.55)",
                  background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.5), rgba(255,255,255,0.02) 60%)",
                  "--ls-drift": `${(scatter(i, 8) - 0.5) * 30}px`,
                  animation: `ls-rise ${9 + scatter(i, 9) * 8}s ease-in ${-scatter(i, 10) * 12}s infinite`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
      <div style={{ position: "relative", zIndex: 1, padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

/** An original little submersible in Conclave coral, headlight tinted by tier. */
function Submersible({ light = "#FFE9A8", size = 1 }: { light?: string; size?: number }) {
  return (
    <svg width={52 * size} height={26 * size} viewBox="0 0 52 26" aria-hidden>
      <defs>
        <linearGradient id={`ls-beam-${light.slice(1)}`} x1="0" x2="1">
          <stop offset="0" stopColor={light} stopOpacity="0.7" />
          <stop offset="1" stopColor={light} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points="31,13 52,3 52,23" fill={`url(#ls-beam-${light.slice(1)})`} />
      <rect x="11" y="2" width="8" height="6" rx="2.5" fill={SUB_HULL} />
      <rect x="4" y="6" width="28" height="15" rx="7.5" fill={SUB_HULL} />
      <rect x="4" y="15" width="28" height="6" rx="3" fill="#000" opacity="0.18" />
      <circle cx="23" cy="13" r="4.2" fill="#0B2540" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.4" />
      <circle cx="21.8" cy="11.8" r="1.2" fill="#fff" opacity="0.7" />
      <ellipse cx="2.5" cy="13.5" rx="1.6" ry="4.5" fill={SUB_HULL} opacity="0.85" />
    </svg>
  );
}

/** Depth readout: the big number is your score, the overline is your zone. */
function DepthHud({ depth, right }: { depth: number; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "rgba(190, 235, 255, 0.72)", fontFamily: HEAD_FONT }}>
          {zoneFor(depth).name}
        </div>
        <div
          style={{
            fontFamily: HEAD_FONT,
            fontSize: 26,
            fontWeight: 500,
            color: color.text,
            lineHeight: 1.1,
            fontVariantNumeric: "tabular-nums",
            transition: "all 600ms ease",
          }}
        >
          {meters(depth)}
        </div>
      </div>
      {right}
    </div>
  );
}

/** Sonar-style countdown with a ping that sweeps outward each second. */
function SonarTimer({ remainingMs, totalMs, label }: { remainingMs: number; totalMs: number; label?: string }) {
  const seconds = Math.ceil(remainingMs / 1000);
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const r = 27;
  const circ = 2 * Math.PI * r;
  const urgent = remainingMs <= 5000;
  const stroke = urgent ? color.accent : GLOW.solid;
  return (
    <div style={{ position: "relative", width: 72, height: 72, flexShrink: 0 }}>
      <svg width={72} height={72} viewBox="0 0 72 72">
        <circle cx={36} cy={36} r={r} fill="rgba(4, 12, 24, 0.55)" stroke="rgba(190,235,255,0.14)" strokeWidth={4} />
        <circle
          key={seconds}
          cx={36}
          cy={36}
          r={30}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          style={{ animation: "ls-ping 1s ease-out" }}
        />
        <circle
          cx={36}
          cy={36}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - ratio)}
          transform="rotate(-90 36 36)"
          style={{ transition: "stroke-dashoffset 200ms linear, stroke 300ms ease", filter: `drop-shadow(0 0 4px ${stroke})` }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT }}>
        <span style={{ fontSize: 20, fontWeight: 500, color: color.text, lineHeight: 1 }}>{seconds}</span>
        {label ? <span style={{ fontSize: 9.5, color: "rgba(190,235,255,0.7)", marginTop: 2 }}>{label}</span> : null}
      </div>
    </div>
  );
}

function Glass({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: radius.md,
        background: "rgba(255, 255, 255, 0.06)",
        border: "1px solid rgba(190, 235, 255, 0.14)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function PromptPlate({ category, prompt, sub }: { category: string | null; prompt: string | null; sub?: string }) {
  return (
    <Glass style={{ padding: "14px 15px 16px" }}>
      <div style={{ fontSize: 11.5, fontFamily: HEAD_FONT, color: GLOW.obvious }}>
        {category}
        {sub ? <span style={{ color: "rgba(190,235,255,0.6)" }}> · {sub}</span> : null}
      </div>
      <div style={{ fontFamily: HEAD_FONT, fontSize: 22, color: color.text, marginTop: 5, lineHeight: 1.2 }}>{prompt}</div>
    </Glass>
  );
}

function TierChip({ tier }: { tier: Tier }) {
  return (
    <span
      style={{
        padding: "1px 8px",
        borderRadius: radius.pill,
        border: `1px solid ${GLOW[tier]}`,
        color: GLOW[tier],
        fontFamily: HEAD_FONT,
        fontSize: 10.5,
        whiteSpace: "nowrap",
        textShadow: `0 0 8px ${GLOW[tier]}`,
      }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

/**
 * The dive column: one band per tier, shallow to deep. It doubles as the
 * scoring legend before you answer and the landing spot after: the
 * submersible sinks into the band your answer belongs to.
 */
function DiveColumn({
  tier,
  counts,
  points,
}: {
  tier?: Tier | null;
  counts?: Record<Tier, number> | null;
  points: Record<Tier, number>;
}) {
  const landed = tier ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {TIERS.map((t, index) => {
        const here = landed === t;
        const dim = landed !== null && !here;
        return (
          <div
            key={t}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: here ? 46 : 32,
              padding: "0 12px",
              borderRadius: radius.sm,
              background: `linear-gradient(90deg, rgba(0,0,0,${0.12 + index * 0.1}), rgba(0,0,0,${0.04 + index * 0.08}))`,
              border: `1px solid ${here ? GLOW[t] : "rgba(190,235,255,0.08)"}`,
              boxShadow: here ? `0 0 18px ${GLOW[t]}55, inset 0 0 14px ${GLOW[t]}33` : undefined,
              opacity: dim ? 0.45 : 1,
              transition: "all 400ms ease",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: GLOW[t], boxShadow: `0 0 8px ${GLOW[t]}` }} />
            <span style={{ fontFamily: HEAD_FONT, fontSize: 12.5, color: color.text }}>{TIER_LABEL[t]}</span>
            <span style={{ flex: 1 }} />
            {counts ? (
              <span style={{ fontSize: 11, color: "rgba(190,235,255,0.6)" }}>{counts[t]} down here</span>
            ) : null}
            <span style={{ fontFamily: HEAD_FONT, fontSize: 12, color: GLOW[t], minWidth: 54, textAlign: "right" }}>
              +{meters(points[t])}
            </span>
            {here ? (
              <span
                key={`sub-${t}`}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: 10,
                  animation: "ls-sink 900ms cubic-bezier(.3,.7,.3,1) both, ls-bob 3s ease-in-out 900ms infinite",
                }}
              >
                <Submersible light={GLOW[t]} size={0.9} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DiveInput({
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
      style={{ display: "flex", gap: 8, animation: shakeKey ? "ls-shake 360ms ease" : undefined }}
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
          border: "1px solid rgba(190, 235, 255, 0.28)",
          background: "rgba(3, 10, 20, 0.55)",
          color: color.text,
          padding: "11px 16px",
          fontSize: 15,
          fontFamily: "inherit",
          outline: "none",
          opacity: disabled ? 0.5 : 1,
          boxShadow: disabled ? undefined : "inset 0 0 12px rgba(57,195,242,0.12)",
        }}
      />
      <PrimaryButton disabled={disabled || busy || !draft.trim()} onClick={() => void submit()}>
        {buttonLabel}
      </PrimaryButton>
    </form>
  );
}

/** Tries as air bubbles: a spent try is a popped (hollow, faded) bubble. */
function AirBubbles({ left, max, label }: { left: number; max: number; label: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} aria-label={label}>
      {Array.from({ length: max }, (_, index) => {
        const full = index < left;
        return (
          <span
            key={index}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              border: `1px solid ${full ? "rgba(210,245,255,0.85)" : "rgba(210,245,255,0.25)"}`,
              background: full ? "radial-gradient(circle at 30% 30%, #fff, rgba(57,195,242,0.5) 60%)" : "transparent",
            }}
          />
        );
      })}
    </span>
  );
}

function missText(miss: Miss, triesLeft?: number): string {
  const base = miss.reason === "used" ? `${miss.text} was already said` : `“${miss.text}” isn't down here`;
  if (typeof triesLeft === "number") {
    return `${base}. ${triesLeft === 0 ? "Out of air." : `${triesLeft} ${triesLeft === 1 ? "breath" : "breaths"} left.`}`;
  }
  return base;
}

/* -------------------------------------------------------------- results */

/** Everyone's dive, side by side: a line from the surface down to their depth. */
function DiveChart({
  rows,
  userId,
  winnerId,
}: {
  rows: { id: string; name: string; score: number }[];
  userId: string | null;
  winnerId: string | null;
}) {
  const shown = rows.slice(0, 8);
  const floor = Math.max(1000, ...shown.map((row) => row.score)) * 1.1;
  const height = 170;
  const lines = ZONES.slice(1).filter((zone) => zone.from < floor);
  return (
    <div style={{ position: "relative", height: height + 36 }}>
      {lines.map((zone) => (
        <div
          key={zone.name}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: (zone.from / floor) * height,
            borderTop: "1px dashed rgba(190,235,255,0.14)",
          }}
        >
          <span style={{ position: "absolute", left: 0, top: 3, width: 52, fontSize: 9, lineHeight: 1.25, color: "rgba(190,235,255,0.5)" }}>
            {zone.name.replace(" zone", "")}
            <br />
            {meters(zone.from)}
          </span>
        </div>
      ))}
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-around", paddingLeft: 52 }}>
        {shown.map((row, index) => {
          const y = (row.score / floor) * height;
          const top = winnerId ? row.id === winnerId : index === 0;
          const glow = top ? GLOW.longShot : row.id === userId ? GLOW.solid : GLOW.obvious;
          return (
            <div key={row.id} style={{ position: "relative", width: 40, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 2,
                  height: y,
                  background: `linear-gradient(180deg, rgba(255,255,255,0.15), ${glow})`,
                  transition: "height 1.4s cubic-bezier(.3,.7,.3,1)",
                }}
              />
              <span
                style={{
                  width: top ? 14 : 10,
                  height: top ? 14 : 10,
                  marginTop: -2,
                  borderRadius: "50%",
                  background: glow,
                  boxShadow: `0 0 12px ${glow}, 0 0 3px #fff`,
                }}
              />
              <span
                style={{
                  position: "absolute",
                  top: height + 6,
                  fontSize: 10.5,
                  color: row.id === userId ? color.text : "rgba(220,240,255,0.7)",
                  fontFamily: HEAD_FONT,
                  maxWidth: 52,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "center",
                }}
              >
                {row.id === userId ? "You" : row.name}
              </span>
              <span style={{ position: "absolute", top: height + 20, fontSize: 9.5, color: "rgba(190,235,255,0.55)" }}>
                {Math.round(row.score).toLocaleString("en-US")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- game */

export default function LongShotGame({
  pub,
  me,
  players,
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
    if (!result.success) setError(result.error ?? "Couldn't send that");
    return result.success;
  };

  /* ---- lobby ---- */
  if (pub.phase === "lobby") {
    const count = `${players.length} ${players.length === 1 ? "diver" : "divers"} on deck`;
    return (
      <Ocean depth={0} rays>
        <div style={{ textAlign: "center", padding: "18px 4px 4px" }}>
          <div style={{ display: "flex", justifyContent: "center", animation: "ls-float 3s ease-in-out infinite" }}>
            <Submersible size={1.6} />
          </div>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 13, color: GLOW.obvious, marginTop: 14 }}>Long Shot</div>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 29, color: color.text, lineHeight: 1.1, marginTop: 8 }}>
            {fuseMode ? "Last one under" : "How deep can you go?"}
          </div>
          <p style={{ fontSize: 13.5, color: "rgba(220,240,255,0.78)", margin: "12px auto 0", maxWidth: 290, lineHeight: 1.55 }}>
            {fuseMode
              ? "Take turns naming an answer nobody has said before your air runs out. Run dry and you surface. The last diver under wins."
              : "Obvious answers keep you in the shallows. Rare ones sink you deep. Say something nobody else did and you sink further."}
          </p>
        </div>
        <DiveColumn points={pub.tierPoints} />
        <div style={{ marginTop: 4 }}>
          {host ? (
            <PrimaryButton full onClick={() => void send({ type: "start" })}>
              {fuseMode ? "Hold your breath" : "Dive"}
            </PrimaryButton>
          ) : (
            <Glass style={{ padding: "12px 16px", textAlign: "center", borderRadius: radius.pill, fontSize: 13, color: color.text }}>
              {readOnly ? "Watching from the boat" : "You're suited up"}
              <span style={{ color: "rgba(220,240,255,0.65)" }}> · {readOnly ? "observer mode" : "the host starts the dive"}</span>
            </Glass>
          )}
          <p style={{ fontSize: 12, color: "rgba(190,235,255,0.6)", textAlign: "center", margin: "10px 0 0" }}>{count}</p>
        </div>
      </Ocean>
    );
  }

  /* ---- results ---- */
  if (pub.phase === "results") {
    const winner = fuseMode
      ? pub.scoreboard.find((row) => row.id === pub.winnerId) ?? null
      : pub.scoreboard[0] ?? null;
    const deepest = pub.scoreboard[0]?.score ?? 0;
    return (
      <Ocean depth={deepest}>
        <div style={{ textAlign: "center", paddingTop: 6 }}>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 12, color: GLOW.longShot, textShadow: `0 0 10px ${GLOW.longShot}` }}>
            {fuseMode ? "Last one under" : "Deepest dive"}
          </div>
          <div style={{ fontFamily: HEAD_FONT, fontSize: 24, color: color.text, marginTop: 6 }}>
            {winner ? `${winner.id === userId ? "You" : winner.name} ${fuseMode ? "outlasted everyone" : `reached ${meters(winner.score)}`}` : "Everyone surfaced"}
          </div>
          {fuseMode && winner ? (
            <div style={{ fontSize: 12, color: "rgba(220,240,255,0.7)", marginTop: 4 }}>+{meters(pub.survivorBonus)} for staying under</div>
          ) : null}
        </div>
        <DiveChart rows={pub.scoreboard} userId={userId} winnerId={fuseMode ? pub.winnerId : null} />
        {pub.best.length > 0 ? (
          <div>
            <div style={{ fontSize: 11, color: "rgba(190,235,255,0.6)", fontFamily: HEAD_FONT, marginBottom: 8 }}>Best catches</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {pub.best.slice(0, 6).map((row) => (
                <Glass key={row.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
                  <span style={{ fontSize: 14, color: color.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.answer}
                    <span style={{ fontSize: 11, color: "rgba(190,235,255,0.6)" }}> · {row.id === userId ? "you" : row.name}</span>
                  </span>
                  <TierChip tier={row.tier} />
                </Glass>
              ))}
            </div>
          </div>
        ) : null}
      </Ocean>
    );
  }

  /* ---- last one under ---- */
  if (fuseMode) {
    if (pub.phase === "popped" && pub.popped) {
      const you = pub.popped.playerId === userId;
      return (
        <Ocean depth={me.score}>
          <div style={{ position: "relative", textAlign: "center", padding: "84px 0 72px" }}>
            <div aria-hidden style={{ position: "absolute", left: "50%", bottom: 30, width: 0, height: 0 }}>
              {Array.from({ length: 16 }, (_, i) => {
                const size = 6 + scatter(i, 11) * 14;
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
                        border: "1px solid rgba(220,245,255,0.8)",
                        "--ls-drift": `${(scatter(i, 13) - 0.5) * 160}px`,
                        animation: `ls-burst ${1.2 + scatter(i, 14)}s ease-out ${scatter(i, 15) * 0.4}s both`,
                      } as React.CSSProperties
                    }
                  />
                );
              })}
            </div>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 38, color: color.text, textShadow: "0 0 18px rgba(57,195,242,0.6)" }}>Out of air</div>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 17, color: color.text, marginTop: 10 }}>
              {you ? "You" : pub.popped.name}{" "}
              {pub.popped.eliminated ? (you ? "surfaced. You're out." : "surfaced. They're out.") : "lost a tank"}
            </div>
            <div style={{ fontSize: 12, color: "rgba(220,240,255,0.7)", marginTop: 8 }}>
              {pub.usedCount} answers found for “{pub.prompt}”
            </div>
            <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 6, marginTop: 22 }}>
              {pub.seats.map((seat) => (
                <span
                  key={seat.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: radius.pill,
                    background: "rgba(255,255,255,0.05)",
                    border: `1px solid ${seat.id === pub.popped?.playerId ? color.accent : "rgba(190,235,255,0.14)"}`,
                    opacity: seat.out ? 0.35 : 1,
                  }}
                >
                  <span style={{ fontSize: 12, color: color.text }}>{seat.id === userId ? "You" : seat.name}</span>
                  <AirBubbles left={seat.lives} max={pub.maxLives} label={`${seat.lives} tanks`} />
                </span>
              ))}
            </div>
            {host ? (
              <div style={{ marginTop: 20 }}>
                <GhostButton onClick={() => void send({ type: "next" })}>Next prompt</GhostButton>
              </div>
            ) : null}
          </div>
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
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {pub.seats.map((seat) => {
            const holding = seat.id === pub.turnPlayerId;
            return (
              <span
                key={seat.id}
                style={
                  {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: radius.pill,
                    background: holding ? "rgba(57,195,242,0.16)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${holding ? GLOW.solid : "rgba(190,235,255,0.14)"}`,
                    opacity: seat.out ? 0.35 : 1,
                    "--ls-c": `${GLOW.solid}66`,
                    animation: holding ? "ls-glow 1.6s ease-in-out infinite" : undefined,
                  } as React.CSSProperties
                }
              >
                <span style={{ fontSize: 12, color: color.text, textDecoration: seat.out ? "line-through" : undefined }}>
                  {seat.id === userId ? "You" : seat.name}
                </span>
                <AirBubbles left={seat.lives} max={pub.maxLives} label={`${seat.lives} tanks`} />
              </span>
            );
          })}
        </div>

        <PromptPlate category={pub.category} prompt={pub.prompt} sub={`${pub.usedCount} found`} />

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span
              style={
                {
                  position: "absolute",
                  width: 84,
                  height: 84,
                  borderRadius: "50%",
                  border: `1.5px solid ${urgent ? color.accent : "rgba(210,245,255,0.75)"}`,
                  background: `radial-gradient(circle at 32% 30%, rgba(255,255,255,0.45), ${urgent ? "rgba(249,95,74,0.25)" : "rgba(57,195,242,0.22)"} 55%, rgba(57,195,242,0.05))`,
                  "--ls-air": `${0.35 + air * 0.65}`,
                  animation: "ls-breathe 1.4s ease-in-out infinite",
                  transition: "border-color 300ms ease",
                } as React.CSSProperties
              }
            />
            <span style={{ position: "relative", fontFamily: HEAD_FONT, fontSize: 18, color: color.text, fontVariantNumeric: "tabular-nums" }}>
              {(remaining / 1000).toFixed(1)}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 15, color: myTurn ? GLOW.solid : color.text }}>
              {myTurn ? "Your breath. Name one!" : holder ? `${holder.name} is holding their breath` : "Waiting for a diver"}
            </div>
            <div style={{ fontSize: 12, color: "rgba(220,240,255,0.65)", marginTop: 4 }}>
              The air gets shorter with every pass.
            </div>
          </div>
        </div>

        <DiveInput
          disabled={!myTurn}
          placeholder={myTurn ? "Name one nobody's said" : "Wait for your breath"}
          buttonLabel="Pass"
          onSubmit={fire}
          shakeKey={missKey}
          autoFocus={myTurn}
        />

        <div style={{ minHeight: 16, fontSize: 12, color: "#FF9C8F" }}>
          {error ??
            (pub.lastMiss ? `${pub.lastMiss.playerId === userId ? "You" : pub.lastMiss.name}: ${missText(pub.lastMiss)}` : null)}
        </div>

        {pub.chain.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {[...pub.chain].reverse().map((link, index) => (
              <div
                key={`${link.answer}-${pub.chain.length - index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  borderRadius: radius.pill,
                  background: index === 0 ? "rgba(255,255,255,0.08)" : "transparent",
                  border: index === 0 ? `1px solid ${GLOW[link.tier]}66` : "1px solid transparent",
                  opacity: Math.max(0.3, 1 - index * 0.13),
                  animation: index === 0 ? "ls-up 420ms ease-out" : undefined,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: GLOW[link.tier], boxShadow: `0 0 8px ${GLOW[link.tier]}` }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {link.answer}
                </span>
                <span style={{ fontSize: 11, color: "rgba(190,235,255,0.6)" }}>{link.playerId === userId ? "you" : link.name}</span>
                <TierChip tier={link.tier} />
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: HEAD_FONT, fontSize: 13, color: color.text }}>
            {meters(me.score)}
            <span style={{ color: "rgba(190,235,255,0.6)" }}> deep{me.rank ? ` · #${me.rank}` : ""}</span>
          </span>
          {host ? <GhostButton onClick={() => void send({ type: "skip" })}>New prompt</GhostButton> : null}
        </div>
      </Ocean>
    );
  }

  /* ---- dive together: reveal ---- */
  if (pub.phase === "reveal") {
    return (
      <Ocean depth={me.score}>
        <DepthHud
          depth={me.score}
          right={
            me.roundPoints > 0 ? (
              <span style={{ fontFamily: HEAD_FONT, fontSize: 15, color: GLOW.solid, textShadow: `0 0 10px ${GLOW.solid}` }}>
                ↓ {meters(me.roundPoints)}
              </span>
            ) : null
          }
        />
        <PromptPlate category={pub.category} prompt={pub.prompt} sub={`Dive ${pub.promptIndex + 1} of ${pub.totalPrompts}`} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {pub.results.map((row) => {
            const glow = row.tier ? GLOW[row.tier] : "rgba(190,235,255,0.2)";
            return (
              <Glass
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderLeft: `3px solid ${glow}`,
                  boxShadow: row.tier === "longShot" ? `0 0 16px ${GLOW.longShot}33` : undefined,
                  animation: "ls-up 420ms ease-out both",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: row.answer ? color.text : "rgba(220,240,255,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.answer ?? "Came up empty"}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(190,235,255,0.6)", marginTop: 1 }}>
                    {row.id === userId ? "You" : row.name}
                    {row.bonus > 0 ? ` · only you, +${meters(row.bonus)}` : row.shared ? " · jinx" : ""}
                  </div>
                </div>
                {row.tier ? <TierChip tier={row.tier} /> : null}
                <span style={{ minWidth: 62, textAlign: "right", fontFamily: HEAD_FONT, fontSize: 13, color: row.points > 0 ? color.text : "rgba(220,240,255,0.45)" }}>
                  {row.points > 0 ? `↓ ${meters(row.points)}` : "0 m"}
                </span>
              </Glass>
            );
          })}
        </div>
        {pub.missedGems.length > 0 ? (
          <div>
            <div style={{ fontSize: 11, color: "rgba(190,235,255,0.6)", fontFamily: HEAD_FONT, marginBottom: 7 }}>Still down there</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pub.missedGems.map((gem) => (
                <span
                  key={gem}
                  style={
                    {
                      fontSize: 12,
                      color: "#FFD1F1",
                      padding: "3px 10px",
                      borderRadius: radius.pill,
                      background: "rgba(255,116,212,0.1)",
                      border: `1px solid ${GLOW.longShot}55`,
                      "--ls-c": `${GLOW.longShot}44`,
                      animation: "ls-glow 3s ease-in-out infinite",
                    } as React.CSSProperties
                  }
                >
                  {gem}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {pub.obviousPicks.length > 0 ? (
          <div style={{ fontSize: 12, color: "rgba(220,240,255,0.6)" }}>In the shallows: {pub.obviousPicks.join(", ")}</div>
        ) : null}
        {host ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <GhostButton onClick={() => void send({ type: "next" })}>Next dive</GhostButton>
          </div>
        ) : null}
      </Ocean>
    );
  }

  /* ---- dive together: prompt ---- */
  const missKey = me.lastMiss?.at ?? null;
  return (
    <Ocean depth={me.score}>
      <DepthHud
        depth={me.score}
        right={<SonarTimer remainingMs={remaining} totalMs={pub.durationMs} label={`${pub.answeredCount}/${pub.totalPlayers}`} />}
      />
      <PromptPlate category={pub.category} prompt={pub.prompt} sub={`Dive ${pub.promptIndex + 1} of ${pub.totalPrompts}`} />

      {me.answer ? (
        <>
          <DiveColumn tier={me.answer.tier} points={pub.tierPoints} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: HEAD_FONT, fontSize: 16, color: color.text }}>
              {me.answer.text}
              <span style={{ color: GLOW[me.answer.tier] }}> sinks {meters(me.answer.points)}</span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(220,240,255,0.65)", marginTop: 5 }}>
              Locked in. If nobody else says it, you sink another {meters(pub.onlyYouBonus)}.
            </div>
          </div>
        </>
      ) : (
        <>
          <DiveColumn counts={pub.tierCounts} points={pub.tierPoints} />
          <DiveInput
            disabled={readOnly || me.locked}
            placeholder={me.locked ? "Out of air this round" : "Go deep…"}
            buttonLabel="Dive"
            onSubmit={fire}
            shakeKey={missKey}
            autoFocus
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 16 }}>
            <span style={{ fontSize: 12, color: me.lastMiss || error ? "#FF9C8F" : "rgba(220,240,255,0.65)" }}>
              {error ??
                (me.lastMiss
                  ? missText(me.lastMiss, me.triesLeft)
                  : readOnly
                    ? "Watching from the boat"
                    : "Typos are forgiven, made-up answers aren't")}
            </span>
            {!readOnly ? <AirBubbles left={me.triesLeft} max={pub.maxTries} label={`${me.triesLeft} tries left`} /> : null}
          </div>
        </>
      )}

      {host ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <GhostButton onClick={() => void send({ type: "skip" })}>Surface now</GhostButton>
        </div>
      ) : null}
    </Ocean>
  );
}
