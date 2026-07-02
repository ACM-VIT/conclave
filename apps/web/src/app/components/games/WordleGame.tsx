"use client";

import React, { useMemo, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import {
  CountdownRing,
  GameLobby,
  HEAD_FONT,
  useRemaining,
  type GameViewProps,
} from "./gameUi";
import type { WordleMove } from "./moves";

type TileState = "green" | "yellow" | "gray";
type PlayerOutcome = "win" | "lose" | "timeout";

type WordlePublic = {
  phase: "lobby" | "set-word" | "playing" | "results";
  wordSource: "random" | "setter";
  setterId: string | null;
  setterName: string | null;
  serverNow: number;
  deadline: number | null;
  timeLimitMs: number;
  wordLength: number;
  maxTries: number;
  standings: Array<{
    playerId: string;
    playerName: string;
    triesUsed: number;
    outcome: PlayerOutcome | null;
    solvedAt: number | null;
  }>;
  finishedCount: number;
  totalContestants: number;
  currentRound: number;
  totalRounds: number;
  isFinalRound: boolean;
  scores: Array<{ playerId: string; playerName: string; score: number }>;
  result: {
    targetWord: string | null;
    winnerId: string | null;
    winnerName: string | null;
  } | null;
};

type WordleMe = {
  isSetter: boolean;
  canSetWord: boolean;
  canGuess: boolean;
  secretWord: string | null;
  myGuesses: Array<{ word: string; feedback: TileState[]; at: number }>;
  myOutcome: PlayerOutcome | null;
  mySolvedAt: number | null;
};

const WORDLE_GREEN = "#538d4e";
const WORDLE_YELLOW = "#b59f3b";
const WORDLE_GRAY = "#3a3a3c";
const KEY_BG = "#818384";

const letterBg = (state: TileState | "empty"): string => {
  if (state === "green") return WORDLE_GREEN;
  if (state === "yellow") return WORDLE_YELLOW;
  if (state === "gray") return WORDLE_GRAY;
  return "transparent";
};

const tileBorder = (state: TileState | "empty", hasLetter: boolean): string => {
  if (state !== "empty") return "transparent";
  return hasLetter ? color.borderStrong : color.border;
};

const keyBg = (state: TileState | undefined): string => {
  if (state === "green") return WORDLE_GREEN;
  if (state === "yellow") return WORDLE_YELLOW;
  if (state === "gray") return WORDLE_GRAY;
  return KEY_BG;
};

const statusText = (outcome: PlayerOutcome | null): string => {
  if (outcome === "win") return "Solved";
  if (outcome === "lose") return "Out of tries";
  if (outcome === "timeout") return "Timed out";
  return "Playing";
};

const normalizeWordInput = (raw: string, label: "Guess" | "Word", wordLength: number) => {
  const trimmed = raw.trim();
  if (trimmed.length !== wordLength) {
    return {
      ok: false as const,
      error: `${label} must be exactly ${wordLength} letters`,
    };
  }
  if (!/^[a-zA-Z]+$/.test(trimmed)) {
    return { ok: false as const, error: `${label} must contain letters only` };
  }
  return { ok: true as const, word: trimmed.toUpperCase() };
};

const formatMmSs = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const FLIP_STYLE = `
@keyframes wordle-flip {
  0% { transform: rotateX(0deg); }
  50% { transform: rotateX(90deg); }
  100% { transform: rotateX(180deg); }
}
`;

const TILE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: HEAD_FONT,
  fontSize: 20,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#ffffff",
};

function Tile({
  letter,
  state,
  animateReveal,
  colIndex,
}: {
  letter: string;
  state: TileState | "empty";
  animateReveal: boolean;
  colIndex: number;
}) {
  const hasLetter = letter.trim().length > 0;
  const isRevealed = state !== "empty";

  if (!animateReveal) {
    return (
      <div
        style={{
          ...TILE_STYLE,
          aspectRatio: "1",
          border: `2px solid ${isRevealed ? "transparent" : tileBorder("empty", hasLetter)}`,
          background: isRevealed ? letterBg(state) : "transparent",
        }}
      >
        {letter}
      </div>
    );
  }

  const delay = colIndex * 300;
  return (
    <div style={{ aspectRatio: "1", perspective: 300 }}>
      <div
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          transformStyle: "preserve-3d",
          animation: `wordle-flip 500ms ease-in-out ${delay}ms both`,
        }}
      >
        <div
          style={{
            ...TILE_STYLE,
            position: "absolute",
            inset: 0,
            backfaceVisibility: "hidden",
            border: `2px solid ${tileBorder("empty", hasLetter)}`,
            background: "transparent",
          }}
        >
          {letter}
        </div>
        <div
          style={{
            ...TILE_STYLE,
            position: "absolute",
            inset: 0,
            backfaceVisibility: "hidden",
            transform: "rotateX(180deg)",
            background: letterBg(state),
          }}
        >
          {letter}
        </div>
      </div>
    </div>
  );
}

export default function WordleGame({
  pub,
  me,
  players,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<WordlePublic, WordleMe>) {
  const [secretDraft, setSecretDraft] = useState("");
  const [guessDraft, setGuessDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const prevGuessCountRef = useRef(me.myGuesses.length);
  const animateRow = useRef(-1);

  const currentCount = me.myGuesses.length;
  if (currentCount > prevGuessCountRef.current) {
    animateRow.current = currentCount - 1;
    prevGuessCountRef.current = currentCount;
  }

  const remainingMs = useRemaining(pub.deadline, pub.serverNow);
  const wordLengthLabel = `${pub.wordLength}-letter`;

  // Typed dispatch: renderers can only send a valid WordleMove. The discriminant
  // is split off so the wire payload stays exactly { word } / undefined as before.
  const runMove = async (typedMove: WordleMove) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { type, ...payload } = typedMove;
      const result = await move(
        type,
        Object.keys(payload).length > 0 ? payload : undefined,
      );
      if (!result.success) {
        setError(result.error ?? "Something went wrong");
        return false;
      }
      return true;
    } catch {
      setError("Something went wrong");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submitSecretWord = async () => {
    if (busyRef.current || readOnly) return;
    const normalized = normalizeWordInput(secretDraft, "Word", pub.wordLength);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }

    const ok = await runMove({ type: "setWord", word: normalized.word });
    if (ok) setSecretDraft("");
  };

  const submitGuess = async () => {
    if (busyRef.current || readOnly) return;
    const normalized = normalizeWordInput(guessDraft, "Guess", pub.wordLength);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }

    const ok = await runMove({ type: "guess", word: normalized.word });
    if (ok) setGuessDraft("");
  };

  const gridRows = useMemo(() => {
    const rows: Array<{ letters: string[]; states: (TileState | "empty")[] }> = [];
    for (let i = 0; i < pub.maxTries; i += 1) {
      const entry = me.myGuesses[i];
      if (entry) {
        rows.push({
          letters: entry.word.split(""),
          states: entry.feedback,
        });
      } else if (
        pub.phase === "playing" &&
        me.canGuess &&
        me.myOutcome == null &&
        i === me.myGuesses.length
      ) {
        const letters = guessDraft
          .toUpperCase()
          .replace(/[^A-Z]/g, "")
          .slice(0, pub.wordLength)
          .padEnd(pub.wordLength)
          .split("");
        rows.push({
          letters,
          states: Array.from({ length: pub.wordLength }, () => "empty" as const),
        });
      } else {
        rows.push({
          letters: Array.from({ length: pub.wordLength }, () => ""),
          states: Array.from({ length: pub.wordLength }, () => "empty" as const),
        });
      }
    }
    return rows;
  }, [guessDraft, me.canGuess, me.myGuesses, me.myOutcome, pub.maxTries, pub.phase, pub.wordLength]);

  const wordleAccent = WORDLE_GREEN;

  const letterStates = useMemo(() => {
    const map: Record<string, TileState> = {};
    const rank: Record<TileState, number> = { gray: 0, yellow: 1, green: 2 };
    for (const guess of me.myGuesses) {
      for (let i = 0; i < guess.word.length; i++) {
        const ch = guess.word[i];
        const fb = guess.feedback[i];
        if (!map[ch] || rank[fb] > rank[map[ch]]) {
          map[ch] = fb;
        }
      }
    }
    return map;
  }, [me.myGuesses]);

  const isRandomMode = pub.wordSource === "random";
  const minPlayers = isRandomMode ? 1 : 2;

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="wordle"
        title={isRandomMode ? "Guess the word" : "Same word, solo boards"}
        blurb={
          isRandomMode
            ? `A random ${wordLengthLabel} word is picked. Everyone guesses on their own board. Fewest tries wins.`
            : `One random player sets a ${wordLengthLabel} word. Everyone else solves it on their own board. Lowest tries wins.`
        }
        players={players}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={players.length >= minPlayers}
        disabledLabel={`Need at least ${minPlayers} player${minPlayers > 1 ? "s" : ""}`}
        startLabel="Start Wordle"
        onStart={() => {
          void runMove({ type: "start" });
        }}
      />
    );
  }

  if (pub.phase === "results" && pub.result) {
    const multiRound = pub.totalRounds > 1;
    return (
      <div style={{ padding: "4px 2px" }}>
        {multiRound ? (
          <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, textAlign: "center", margin: "0 0 2px" }}>
            Round {pub.currentRound} of {pub.totalRounds}
          </p>
        ) : null}
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "0 0 4px", textAlign: "center" }}>
          {pub.isFinalRound ? (multiRound ? "Game over" : pub.result.winnerName ? "Round complete" : "No winner") : pub.result.winnerName ? "Round complete" : "No winner"}
        </p>
        {pub.result.winnerName ? (
          <p style={{ fontSize: 13, color: wordleAccent, textAlign: "center", margin: "0 0 6px" }}>
            {pub.result.winnerName} cracked it
          </p>
        ) : null}
        <p style={{ fontSize: 13, color: color.textMuted, textAlign: "center", margin: "0 0 16px" }}>
          The word was{" "}
          <span style={{ color: color.text, fontFamily: HEAD_FONT, fontWeight: 600, letterSpacing: "0.12em" }}>
            {pub.result.targetWord ?? "?"}
          </span>
        </p>

        {multiRound && pub.scores.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 6px" }}>
              {pub.isFinalRound ? "Final scores" : "Scores"}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pub.scores.map((entry, i) => (
                <div
                  key={entry.playerId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: radius.sm,
                    background: i === 0 && pub.isFinalRound ? `${wordleAccent}22` : "transparent",
                  }}
                >
                  <span style={{ width: 16, fontSize: 12, color: i === 0 ? wordleAccent : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.playerName}
                  </span>
                  <span style={{ fontSize: 12, color: wordleAccent, fontFamily: HEAD_FONT, fontWeight: 600 }}>
                    {entry.score} pt{entry.score !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
            {pub.standings.map((entry, i) => (
              <div
                key={entry.playerId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: radius.sm,
                  background: entry.outcome === "win" ? `${wordleAccent}22` : "transparent",
                }}
              >
                <span style={{ width: 16, fontSize: 12, color: i === 0 && entry.outcome === "win" ? wordleAccent : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.playerName}
                </span>
                <span style={{ fontSize: 12, color: color.textMuted, fontFamily: HEAD_FONT }}>
                  {entry.outcome === "win" ? `${entry.triesUsed}/${pub.maxTries}` : statusText(entry.outcome)}
                </span>
              </div>
            ))}
          </div>
        )}

        {!pub.isFinalRound && isAdmin && !readOnly ? (
          <button
            disabled={busy}
            onClick={() => void runMove({ type: "nextRound" })}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: radius.md,
              border: "none",
              background: WORDLE_GREEN,
              color: "#fff",
              fontFamily: HEAD_FONT,
              fontWeight: 700,
              fontSize: 15,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Next Round
          </button>
        ) : !pub.isFinalRound ? (
          <p style={{ fontSize: 12, color: color.textMuted, textAlign: "center", margin: 0 }}>
            Waiting for host to start next round...
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{FLIP_STYLE}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <p style={{ margin: 0, color: wordleAccent, fontFamily: HEAD_FONT, fontSize: 12 }}>
            {isRandomMode ? "Wordle" : pub.setterName ? `Set by ${pub.setterName}` : "Wordle"}
            {pub.totalRounds > 1 ? ` · Round ${pub.currentRound}/${pub.totalRounds}` : ""}
          </p>
          <p style={{ margin: "2px 0 0", color: color.textFaint, fontSize: 11 }}>
            {pub.finishedCount}/{pub.totalContestants} finished
            {pub.phase === "playing" ? ` · ${formatMmSs(remainingMs)}` : ""}
          </p>
        </div>
        {pub.phase === "playing" ? (
          <CountdownRing
            remainingMs={remainingMs}
            totalMs={pub.timeLimitMs}
            label={`${pub.finishedCount}/${pub.totalContestants}`}
          />
        ) : null}
      </div>

      {pub.phase === "set-word" ? (
        me.canSetWord ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "16px 0 8px" }}>
            <p style={{ margin: 0, color: color.text, fontFamily: HEAD_FONT, fontSize: 17 }}>
              You're the word setter
            </p>
            <p style={{ margin: 0, color: color.textMuted, fontSize: 13, lineHeight: 1.5, textAlign: "center", maxWidth: 260 }}>
              Pick a valid {wordLengthLabel} English word. Everyone else will try to guess it.
            </p>
            <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 300 }}>
              <input
                value={secretDraft}
                maxLength={pub.wordLength}
                disabled={busy || readOnly}
                onChange={(event) => setSecretDraft(event.currentTarget.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!busy && !readOnly) void submitSecretWord();
                  }
                }}
                placeholder="WORD"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: radius.md,
                  border: `1px solid ${color.border}`,
                  background: color.surfaceRaised,
                  color: color.text,
                  letterSpacing: "0.2em",
                  fontFamily: HEAD_FONT,
                  fontSize: 16,
                  textAlign: "center",
                }}
              />
              <button
                disabled={busy || readOnly}
                onClick={() => void submitSecretWord()}
                style={{
                  padding: "10px 28px",
                  borderRadius: radius.md,
                  border: "none",
                  background: WORDLE_GREEN,
                  color: "#fff",
                  fontFamily: HEAD_FONT,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: busy || readOnly ? "default" : "pointer",
                  opacity: busy || readOnly ? 0.5 : 1,
                }}
              >
                Set
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              padding: "13px 16px",
              borderRadius: radius.pill,
              background: color.surfaceRaised,
              border: `1px solid ${color.border}`,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: radius.pill, background: wordleAccent }} />
            <span style={{ fontSize: 13, color: color.text }}>
              {pub.setterName ?? "Someone"} is picking a word
            </span>
          </div>
        )
      ) : null}

      {!me.isSetter && pub.phase !== "set-word" ? (
        <>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{ display: "grid", gap: 5, maxWidth: 260, width: "100%" }}>
              {gridRows.map((row, rowIndex) => (
                <div
                  key={`row-${rowIndex}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${pub.wordLength}, 1fr)`,
                    gap: 5,
                  }}
                >
                  {row.letters.map((letter, colIndex) => (
                    <Tile
                      key={`tile-${rowIndex}-${colIndex}`}
                      letter={letter}
                      state={row.states[colIndex]}
                      animateReveal={rowIndex === animateRow.current}
                      colIndex={colIndex}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {pub.phase === "playing" && me.canGuess && !me.myOutcome ? (
            <div style={{ display: "flex", gap: 8, maxWidth: 300, width: "100%", alignSelf: "center" }}>
              <input
                value={guessDraft}
                maxLength={pub.wordLength}
                disabled={busy || readOnly}
                onChange={(event) => setGuessDraft(event.currentTarget.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!busy && !readOnly) void submitGuess();
                  }
                }}
                placeholder="GUESS"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: radius.md,
                  border: `1px solid ${color.border}`,
                  background: color.surfaceRaised,
                  color: color.text,
                  letterSpacing: "0.18em",
                  fontFamily: HEAD_FONT,
                  fontSize: 15,
                  textAlign: "center",
                }}
              />
              <button
                disabled={busy || readOnly}
                onClick={() => void submitGuess()}
                style={{
                  padding: "10px 28px",
                  borderRadius: radius.md,
                  border: "none",
                  background: WORDLE_GREEN,
                  color: "#fff",
                  fontFamily: HEAD_FONT,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: busy || readOnly ? "default" : "pointer",
                  opacity: busy || readOnly ? 0.5 : 1,
                }}
              >
                Go
              </button>
            </div>
          ) : null}

          {me.myGuesses.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
              {KEYBOARD_ROWS.map((row, ri) => (
                <div key={ri} style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                  {row.map((ch) => {
                    const st = letterStates[ch];
                    return (
                      <span
                        key={ch}
                        style={{
                          width: 26,
                          height: 32,
                          borderRadius: 4,
                          background: keyBg(st),
                          color: "#fff",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontFamily: HEAD_FONT,
                          fontWeight: 700,
                        }}
                      >
                        {ch}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : pub.phase !== "set-word" ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            padding: "13px 16px",
            borderRadius: radius.pill,
            background: color.surfaceRaised,
            border: `1px solid ${color.border}`,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: radius.pill, background: wordleAccent }} />
          <span style={{ fontSize: 13, color: color.text }}>You set the word</span>
          <span style={{ fontSize: 13, color: color.textMuted }}>· watching players guess</span>
        </div>
      ) : null}

      {pub.standings.length > 0 && pub.phase === "playing" ? (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${color.border}` }}>
          <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 6px" }}>Standings</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {pub.standings.map((entry, i) => (
              <div
                key={entry.playerId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "5px 10px",
                  borderRadius: radius.sm,
                  background: entry.outcome === "win" ? `${wordleAccent}22` : "transparent",
                }}
              >
                <span style={{ width: 16, fontSize: 12, color: i === 0 && entry.outcome === "win" ? wordleAccent : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.playerName}
                </span>
                <span style={{ fontSize: 11, color: entry.outcome === "win" ? wordleAccent : color.textMuted, fontFamily: HEAD_FONT }}>
                  {entry.outcome ? statusText(entry.outcome) : `${entry.triesUsed}/${pub.maxTries}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 24 }}>
        <span style={{ fontSize: 12, color: color.textMuted }}>
          {me.myOutcome
            ? statusText(me.myOutcome)
            : readOnly
              ? "Watching only"
              : pub.phase === "playing" && me.canGuess
                ? `${me.myGuesses.length}/${pub.maxTries} tries`
                : ""}
        </span>
      </div>

      {error ? <p style={{ margin: 0, color: color.danger, fontSize: 12 }}>{error}</p> : null}
    </div>
  );
}
