"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import {
  CountdownRing,
  GameLobby,
  GhostButton,
  HEAD_FONT,
  useRemaining,
  type GameViewProps,
} from "./gameUi";
import type { WordleMove } from "./moves";

type TileState = "green" | "yellow" | "gray";
type PlayerOutcome = "win" | "lose" | "timeout";
type WordleMode = "solo" | "relay" | "huddle";

type TeamGuess = {
  word: string;
  feedback: TileState[];
  at: number;
  byId: string;
  byName: string | null;
};

type WordleTeam = {
  guesses: TeamGuess[];
  outcome: PlayerOutcome | null;
  solvedById: string | null;
  solvedByName: string | null;
  members: Array<{ playerId: string; playerName: string; active: boolean }>;
  currentTurnId: string | null;
  currentTurnName: string | null;
  nextTurnId: string | null;
  turnDeadline: number | null;
};

type WordlePublic = {
  phase: "lobby" | "set-word" | "playing" | "results";
  mode?: WordleMode;
  turnTimeMs?: number;
  team?: WordleTeam | null;
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
  currentRound: number;
  isSetter: boolean;
  isMyTurn?: boolean;
  isUpNext?: boolean;
  canSetWord: boolean;
  canGuess: boolean;
  secretWord: string | null;
  myGuesses: Array<{ word: string; feedback: TileState[]; at: number }>;
  myOutcome: PlayerOutcome | null;
  mySolvedAt: number | null;
  boards: Array<{
    playerId: string;
    guesses: Array<{ word: string; feedback: TileState[]; at: number }>;
    outcome: PlayerOutcome | null;
  }> | null;
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

const TILE_MEANING: Record<TileState, string> = {
  green: "correct",
  yellow: "in the word, wrong spot",
  gray: "not in the word",
};

const tileLabel = (letter: string, state: TileState | "empty"): string => {
  if (!letter.trim()) return "empty";
  return state === "empty" ? letter : `${letter}, ${TILE_MEANING[state]}`;
};

const tileCue = (state: TileState | "empty", inset = 5, width = 2): React.CSSProperties => {
  if (state === "green") {
    return { outline: `${width}px solid rgba(255, 255, 255, 0.6)`, outlineOffset: -inset - width };
  }
  if (state === "yellow") {
    return { outline: `${width}px dashed rgba(255, 255, 255, 0.8)`, outlineOffset: -inset - width };
  }
  return {};
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
        role="img"
        aria-label={tileLabel(letter, state)}
        style={{
          ...TILE_STYLE,
          aspectRatio: "1",
          border: `2px solid ${isRevealed ? "transparent" : tileBorder("empty", hasLetter)}`,
          background: isRevealed ? letterBg(state) : "transparent",
          ...tileCue(state),
        }}
      >
        {letter}
      </div>
    );
  }

  const delay = colIndex * 300;
  return (
    <div role="img" aria-label={tileLabel(letter, state)} style={{ aspectRatio: "1", perspective: 300 }}>
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
            ...tileCue(state),
          }}
        >
          {letter}
        </div>
      </div>
    </div>
  );
}

const teamOutcomeTitle = (outcome: PlayerOutcome | null): string => {
  if (outcome === "win") return "Team cracked it!";
  if (outcome === "lose") return "Out of tries";
  if (outcome === "timeout") return "Time's up";
  return "Round complete";
};

function TeamMembers({ team }: { team: WordleTeam }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
      {team.members.map((member, index) => {
        const current = member.playerId === team.currentTurnId;
        return (
          <span
            key={member.playerId}
            title={member.active ? member.playerName : `${member.playerName} (away, skipped)`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              maxWidth: 120,
              padding: "3px 9px",
              borderRadius: radius.pill,
              border: `1px solid ${current ? WORDLE_GREEN : color.border}`,
              background: current ? `${WORDLE_GREEN}26` : "transparent",
              color: current ? color.text : color.textMuted,
              fontSize: 11.5,
              fontFamily: HEAD_FONT,
              opacity: member.active ? 1 : 0.4,
              whiteSpace: "nowrap",
            }}
          >
            {team.currentTurnId != null ? (
              <span style={{ fontSize: 10, color: current ? WORDLE_GREEN : color.textFaint }}>
                {index + 1}
              </span>
            ) : null}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {member.playerName}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function TeamBanner({
  mode,
  team,
  me,
  turnRemainingMs,
  canPass,
  busy,
  readOnly,
  onPass,
}: {
  mode: WordleMode;
  readOnly: boolean;
  team: WordleTeam;
  me: WordleMe;
  turnRemainingMs: number;
  canPass: boolean;
  busy: boolean;
  onPass: () => void;
}) {
  const seconds = Math.max(0, Math.ceil(turnRemainingMs / 1000));
  const lowTime = seconds <= 5;
  const pill: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "10px 14px",
    borderRadius: radius.lg,
    border: `1px solid ${color.border}`,
    background: color.surfaceRaised,
  };

  if (me.isSetter) {
    return (
      <div style={{ ...pill, justifyContent: "center" }}>
        <span style={{ fontSize: 13, color: color.text }}>You set the word</span>
        <span style={{ fontSize: 13, color: color.textMuted }}>· watching the team</span>
      </div>
    );
  }

  if (mode === "huddle" && (!me.canGuess || readOnly)) {
    return (
      <div style={{ ...pill, justifyContent: "center" }}>
        <span style={{ fontSize: 13, color: color.text }}>Watching the team</span>
      </div>
    );
  }

  if (mode === "huddle") {
    return (
      <div style={{ ...pill, flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13.5, color: color.text, fontFamily: HEAD_FONT }}>
          One board, no turns
        </span>
        <span style={{ fontSize: 12, color: color.textMuted, textAlign: "center" }}>
          Talk it through on the call. Anyone can type the next guess.
        </span>
      </div>
    );
  }

  const timer = (
    <span
      style={{
        marginLeft: "auto",
        fontFamily: HEAD_FONT,
        fontSize: 13,
        fontVariantNumeric: "tabular-nums",
        color: lowTime ? color.danger : color.textMuted,
      }}
    >
      {seconds}s
    </span>
  );

  if (me.isMyTurn) {
    return (
      <div
        style={{
          ...pill,
          border: `1px solid ${WORDLE_GREEN}`,
          background: `${WORDLE_GREEN}26`,
        }}
      >
        <span style={{ fontSize: 14, color: color.text, fontFamily: HEAD_FONT, fontWeight: 600, whiteSpace: "nowrap" }}>
          Your turn
        </span>
        {timer}
        {canPass ? (
          <GhostButton onClick={onPass} disabled={busy}>
            Pass
          </GhostButton>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ ...pill, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, color: color.text, minWidth: 0 }}>
        {team.currentTurnName ?? "A teammate"} is guessing
      </span>
      {me.isUpNext ? (
        <span style={{ fontSize: 12, color: WORDLE_GREEN, fontFamily: HEAD_FONT }}>· you're next</span>
      ) : null}
      {timer}
    </div>
  );
}

function SetterBoards({
  boards,
  standings,
  wordLength,
  maxTries,
}: {
  boards: NonNullable<WordleMe["boards"]>;
  standings: WordlePublic["standings"];
  wordLength: number;
  maxTries: number;
}) {
  const nameById = new Map(
    standings.map((entry) => [entry.playerId, entry.playerName]),
  );
  const rankById = new Map(
    standings.map((entry, index) => [entry.playerId, index]),
  );
  const ordered = [...boards].sort(
    (a, b) =>
      (rankById.get(a.playerId) ?? Number.MAX_SAFE_INTEGER) -
      (rankById.get(b.playerId) ?? Number.MAX_SAFE_INTEGER),
  );

  return (
    <div>
      <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 8px" }}>
        Live boards
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))",
          gap: 10,
        }}
      >
        {ordered.map((board) => {
          const solved = board.outcome === "win";
          return (
            <div
              key={board.playerId}
              style={{
                padding: 8,
                borderRadius: radius.md,
                border: `1px solid ${solved ? `${WORDLE_GREEN}66` : color.border}`,
                background: solved ? `${WORDLE_GREEN}14` : color.surfaceRaised,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11.5,
                    color: color.text,
                    fontFamily: HEAD_FONT,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {nameById.get(board.playerId) ?? "Player"}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: HEAD_FONT,
                    color:
                      board.outcome === "win"
                        ? WORDLE_GREEN
                        : board.outcome
                          ? color.textMuted
                          : color.textFaint,
                    whiteSpace: "nowrap",
                  }}
                >
                  {board.outcome
                    ? statusText(board.outcome)
                    : `${board.guesses.length}/${maxTries}`}
                </span>
              </div>
              <div style={{ display: "grid", gap: 2 }}>
                {Array.from({ length: maxTries }, (_, rowIndex) => {
                  const guess = board.guesses[rowIndex];
                  return (
                    <div
                      key={rowIndex}
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${wordLength}, 1fr)`,
                        gap: 2,
                      }}
                    >
                      {Array.from({ length: wordLength }, (_, colIndex) => (
                        <div
                          key={colIndex}
                          style={{
                            aspectRatio: "1",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: HEAD_FONT,
                            fontSize: 9,
                            fontWeight: 700,
                            color: "#ffffff",
                            borderRadius: 2,
                            border: guess
                              ? "1px solid transparent"
                              : `1px solid ${color.border}`,
                            background: guess
                              ? letterBg(guess.feedback[colIndex])
                              : "transparent",
                            ...(guess ? tileCue(guess.feedback[colIndex], 1, 1) : {}),
                          }}
                          role="img"
                          aria-label={guess ? tileLabel(guess.word[colIndex] ?? "", guess.feedback[colIndex]) : "empty"}
                        >
                          {guess ? guess.word[colIndex] : ""}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
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
  const teamView = pub.team ?? null;
  const mode: WordleMode = pub.mode ?? "solo";
  const isTeamMode = mode !== "solo";
  const boardGuesses: Array<{ word: string; feedback: TileState[]; at: number; byName?: string | null }> =
    teamView ? teamView.guesses : me.myGuesses;
  const boardOutcome = teamView ? teamView.outcome : me.myOutcome;
  const prevGuessCountRef = useRef(boardGuesses.length);
  const animateRow = useRef(-1);
  const guessInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [lastRoundKey, setLastRoundKey] = useState(pub.currentRound);
  if (lastRoundKey !== pub.currentRound) {
    setLastRoundKey(pub.currentRound);
    setSecretDraft("");
    setGuessDraft("");
    setError(null);
    prevGuessCountRef.current = 0;
    animateRow.current = -1;
  }

  const currentCount = boardGuesses.length;
  if (currentCount > prevGuessCountRef.current) {
    animateRow.current = currentCount - 1;
    prevGuessCountRef.current = currentCount;
  } else if (currentCount < prevGuessCountRef.current) {
    prevGuessCountRef.current = currentCount;
    animateRow.current = -1;
  }

  const remainingMs = useRemaining(pub.deadline, pub.serverNow);
  const turnRemainingMs = useRemaining(teamView?.turnDeadline ?? null, pub.serverNow);

  const myTurnNow = isTeamMode && pub.phase === "playing" && me.canGuess && Boolean(me.isMyTurn);
  useEffect(() => {
    if (!myTurnNow || readOnly) return;
    const active = document.activeElement;
    const focusIsFree =
      !active || active === document.body || Boolean(rootRef.current?.contains(active));
    if (focusIsFree) guessInputRef.current?.focus();
  }, [myTurnNow, readOnly]);

  const [wasMyTurn, setWasMyTurn] = useState(myTurnNow);
  if (wasMyTurn !== myTurnNow) {
    setWasMyTurn(myTurnNow);
    if (!myTurnNow) setGuessDraft("");
  }
  const wordLengthLabel = `${pub.wordLength}-letter`;

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
      const entry = boardGuesses[i];
      if (entry) {
        rows.push({
          letters: entry.word.split(""),
          states: entry.feedback,
        });
      } else if (
        pub.phase === "playing" &&
        me.canGuess &&
        boardOutcome == null &&
        i === boardGuesses.length
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
  }, [guessDraft, me.canGuess, boardGuesses, boardOutcome, pub.maxTries, pub.phase, pub.wordLength]);

  const wordleAccent = WORDLE_GREEN;

  const letterStates = useMemo(() => {
    const map: Record<string, TileState> = {};
    const rank: Record<TileState, number> = { gray: 0, yellow: 1, green: 2 };
    for (const guess of boardGuesses) {
      for (let i = 0; i < guess.word.length; i++) {
        const ch = guess.word[i];
        const fb = guess.feedback[i];
        if (!map[ch] || rank[fb] > rank[map[ch]]) {
          map[ch] = fb;
        }
      }
    }
    return map;
  }, [boardGuesses]);

  const isRandomMode = pub.wordSource === "random";
  const minPlayers = isRandomMode ? 1 : 2;
  const setterBoards =
    me.currentRound === pub.currentRound ? me.boards : null;

  const turnSeconds = Math.round((pub.turnTimeMs ?? 45_000) / 1000);
  const wordIntro = isRandomMode
    ? `A random ${wordLengthLabel} word is picked`
    : `One random player sets a ${wordLengthLabel} word`;
  const lobbyBlurb =
    mode === "relay"
      ? `${wordIntro}. ${isRandomMode ? "Everyone shares" : "Everyone else shares"} one board and takes turns guessing, ${turnSeconds}s each. Talk it through on the call.`
      : mode === "huddle"
        ? `${wordIntro}. ${isRandomMode ? "Everyone shares" : "Everyone else shares"} one board, and anyone can guess at any time. Talk it through on the call.`
        : isRandomMode
          ? `${wordIntro}. Everyone guesses on their own board. Fewest tries wins.`
          : `${wordIntro}. Everyone else solves it on their own board. Lowest tries wins.`;

  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="wordle"
        title={
          isTeamMode
            ? "Crack it together"
            : isRandomMode
              ? "Guess the word"
              : "Same word, solo boards"
        }
        blurb={lobbyBlurb}
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
          {teamView
            ? pub.isFinalRound && multiRound
              ? "Game over"
              : teamOutcomeTitle(teamView.outcome)
            : pub.isFinalRound ? (multiRound ? "Game over" : pub.result.winnerName ? "Round complete" : "No winner") : pub.result.winnerName ? "Round complete" : "No winner"}
        </p>
        {teamView ? (
          pub.isFinalRound && multiRound && teamView.outcome !== "win" ? (
            <p style={{ fontSize: 13, color: color.textMuted, textAlign: "center", margin: "0 0 6px" }}>
              Last round: {teamOutcomeTitle(teamView.outcome).toLowerCase()}
            </p>
          ) : teamView.outcome === "win" ? (
            <p style={{ fontSize: 13, color: wordleAccent, textAlign: "center", margin: "0 0 6px" }}>
              Solved in {teamView.guesses.length}/{pub.maxTries}
              {teamView.solvedByName ? ` · ${teamView.solvedByName} landed the final guess` : ""}
            </p>
          ) : null
        ) : pub.result.winnerName ? (
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

        {teamView ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12, alignItems: "center" }}>
            {teamView.guesses.map((guess, rowIndex) => (
              <div key={rowIndex} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${pub.wordLength}, 22px)`, gap: 3 }}>
                  {guess.word.split("").map((letter, colIndex) => (
                    <div
                      key={colIndex}
                      role="img"
                      aria-label={tileLabel(letter, guess.feedback[colIndex])}
                      style={{
                        ...TILE_STYLE,
                        fontSize: 11,
                        height: 22,
                        borderRadius: 3,
                        background: letterBg(guess.feedback[colIndex]),
                        ...tileCue(guess.feedback[colIndex], 1.5, 1),
                      }}
                    >
                      {letter}
                    </div>
                  ))}
                </div>
                <span style={{ width: 80, fontSize: 11.5, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {guess.byName ?? "Teammate"}
                </span>
              </div>
            ))}
          </div>
        ) : null}

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
        ) : null}

        {!teamView && !(multiRound && pub.scores.length > 0) ? (
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
        ) : null}

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
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{FLIP_STYLE}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, color: wordleAccent, fontFamily: HEAD_FONT, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {isTeamMode ? "Team Wordle" : isRandomMode ? "Wordle" : pub.setterName ? `Set by ${pub.setterName}` : "Wordle"}
            {isTeamMode && !isRandomMode && pub.setterName ? ` · set by ${pub.setterName}` : ""}
            {pub.totalRounds > 1 ? ` · Round ${pub.currentRound}/${pub.totalRounds}` : ""}
          </p>
          <p style={{ margin: "2px 0 0", color: color.textFaint, fontSize: 11 }}>
            {teamView
              ? `${boardGuesses.length}/${pub.maxTries} tries used`
              : `${pub.finishedCount}/${pub.totalContestants} finished`}
            {pub.phase === "playing" ? ` · ${formatMmSs(remainingMs)}` : ""}
          </p>
        </div>
        {pub.phase === "playing" ? (
          <CountdownRing
            remainingMs={remainingMs}
            totalMs={pub.timeLimitMs}
            label={
              teamView
                ? `${boardGuesses.length}/${pub.maxTries}`
                : `${pub.finishedCount}/${pub.totalContestants}`
            }
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
              Pick a valid {wordLengthLabel} English word.{" "}
              {isTeamMode ? "Everyone else will crack it together." : "Everyone else will try to guess it."}
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
            <span style={{ fontSize: 13, color: color.text }}>
              {pub.setterName ?? "Someone"} is picking a word
            </span>
          </div>
        )
      ) : null}

      {(teamView || !me.isSetter) && pub.phase !== "set-word" ? (
        <>
          {teamView && pub.phase === "playing" ? (
            <>
              <TeamBanner
                mode={mode}
                team={teamView}
                me={me}
                turnRemainingMs={turnRemainingMs}
                canPass={
                  mode === "relay" &&
                  myTurnNow &&
                  !readOnly &&
                  teamView.members.some(
                    (member) => member.active && member.playerId !== teamView.currentTurnId,
                  )
                }
                busy={busy}
                readOnly={readOnly}
                onPass={() => {
                  void runMove({ type: "passTurn" }).then((ok) => {
                    if (ok) setGuessDraft("");
                  });
                }}
              />
              <TeamMembers team={teamView} />
            </>
          ) : null}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{ display: "grid", gap: 5, maxWidth: teamView ? 330 : 260, width: "100%" }}>
              {gridRows.map((row, rowIndex) => {
                const grid = (
                  <div
                    key={`row-${rowIndex}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${pub.wordLength}, 1fr)`,
                      gap: 5,
                      flex: 1,
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
                );
                if (!teamView) return grid;
                const guess = teamView.guesses[rowIndex];
                const upNext =
                  !guess && rowIndex === teamView.guesses.length && teamView.outcome == null
                    ? me.isMyTurn && mode === "relay"
                      ? "You"
                      : teamView.currentTurnName
                    : null;
                return (
                  <div key={`row-${rowIndex}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {grid}
                    <span
                      style={{
                        width: 62,
                        fontSize: 11,
                        fontFamily: HEAD_FONT,
                        color: upNext ? WORDLE_GREEN : color.textFaint,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {guess ? guess.byName ?? "Teammate" : upNext ? `${upNext}…` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {pub.phase === "playing" && me.canGuess && !me.myOutcome ? (
            <div style={{ display: "flex", gap: 8, maxWidth: 300, width: "100%", alignSelf: "center" }}>
              <input
                ref={guessInputRef}
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

          {boardGuesses.length > 0 ? (
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
        <>
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
            <span style={{ fontSize: 13, color: color.text }}>You set the word</span>
            <span style={{ fontSize: 13, color: color.textMuted }}>· watching players guess</span>
          </div>
          {setterBoards && setterBoards.length > 0 ? (
            <SetterBoards
              boards={setterBoards}
              standings={pub.standings}
              wordLength={pub.wordLength}
              maxTries={pub.maxTries}
            />
          ) : null}
        </>
      ) : null}

      {!teamView && pub.standings.length > 0 && pub.phase === "playing" ? (
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
          {teamView
            ? readOnly
              ? "Watching only"
              : ""
            : me.myOutcome
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
