import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import { useApps } from "../../../../sdk/hooks/useApps";
import {
  addEntries,
  clearEntries,
  clearHistory,
  createEntryId,
  getEntries,
  getHistory,
  getRemoveWinnerOnDone,
  recordResult,
  removeEntryById,
  replaceEntries,
  setRemoveWinnerOnDone,
  startSpin,
  type WheelSpin,
} from "../../core/doc/index";
import { useWheelDocState } from "../hooks/useWheelDocState";
import { segmentColor } from "../palette";
import { WheelSounds } from "../sounds";
import { WheelPanel } from "./WheelPanel";
import { WheelStage } from "./WheelStage";
import { WinnerOverlay } from "./WinnerOverlay";

const APP_ID = "wheel";
const SOUND_PREF_KEY = "conclave:wheel:sound";

const SPIN_MIN_DURATION_MS = 7200;
const SPIN_DURATION_SPREAD_MS = 1600;
const SPIN_MIN_TURNS = 7;
const SPIN_TURNS_SPREAD = 3;
/** Pause between the wheel stopping and the winner card, for the reveal beat. */
const REVEAL_DELAY_MS = 800;
/** Non-spinners record the outcome themselves if the spinner vanishes. */
const RESULT_FAILOVER_MS = 2600;

const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const handleChange = (event: MediaQueryListEvent) =>
      setReduced(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);
  return reduced;
};

const readSoundPreference = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "0";
  } catch {
    return true;
  }
};

const SoundOnIcon = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M11 4.7 6.6 8H3.4A.4.4 0 0 0 3 8.4v7.2c0 .22.18.4.4.4h3.2L11 19.3a.5.5 0 0 0 .8-.4V5.1a.5.5 0 0 0-.8-.4Z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19.4 5.6a9 9 0 0 1 0 12.8" />
  </svg>
);

const SoundOffIcon = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M11 4.7 6.6 8H3.4A.4.4 0 0 0 3 8.4v7.2c0 .22.18.4.4.4h3.2L11 19.3a.5.5 0 0 0 .8-.4V5.1a.5.5 0 0 0-.8-.4Z" />
    <path d="m22 9-6 6" />
    <path d="m16 9 6 6" />
  </svg>
);

export function WheelWebApp() {
  const { doc, locked } = useAppDoc(APP_ID);
  const { user, isAdmin, isReadOnly, participants } = useApps();
  const { entries, spin, history, removeWinnerOnDone } = useWheelDocState(doc);

  const canEdit = !isReadOnly && (!locked || Boolean(isAdmin));
  const reducedMotion = useReducedMotion();

  const [isSpinning, setIsSpinning] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [overlaySpin, setOverlaySpin] = useState<WheelSpin | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [soundOn, setSoundOn] = useState(readSoundPreference);

  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  const soundsRef = useRef<WheelSounds | null>(null);
  if (soundsRef.current === null && typeof window !== "undefined") {
    soundsRef.current = new WheelSounds();
  }

  useEffect(() => {
    if (soundsRef.current) soundsRef.current.enabled = soundOn;
    try {
      window.localStorage.setItem(SOUND_PREF_KEY, soundOn ? "1" : "0");
    } catch {
      // Private mode etc. — preference just won't persist.
    }
  }, [soundOn]);

  useEffect(() => {
    const sounds = soundsRef.current;
    return () => {
      sounds?.dispose();
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      if (failoverTimerRef.current) clearTimeout(failoverTimerRef.current);
    };
  }, []);

  // A new spin from anyone replaces whatever ceremony is on screen.
  const activeSpinId = spin?.spinId;
  useEffect(() => {
    setOverlaySpin(null);
    setHighlightIndex(null);
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (failoverTimerRef.current) {
      clearTimeout(failoverTimerRef.current);
      failoverTimerRef.current = null;
    }
  }, [activeSpinId]);

  const handleRequestSpin = useCallback(() => {
    if (!canEdit || isSpinning || revealTimerRef.current) return;
    const liveEntries = getEntries(doc);
    if (liveEntries.length < 2) return;

    const record: WheelSpin = {
      spinId: createEntryId(),
      entries: liveEntries,
      winnerIndex: Math.floor(Math.random() * liveEntries.length),
      startedAt: Date.now(),
      durationMs:
        SPIN_MIN_DURATION_MS + Math.round(Math.random() * SPIN_DURATION_SPREAD_MS),
      turns: SPIN_MIN_TURNS + Math.floor(Math.random() * SPIN_TURNS_SPREAD),
      jitter: 0.15 + Math.random() * 0.7,
      spunById: user?.id ?? "unknown",
      spunByName: user?.name ?? user?.email ?? "Someone",
    };
    startSpin(doc, record);
  }, [canEdit, isSpinning, doc, user]);

  const handleSettled = useCallback(
    (settled: WheelSpin, fresh: boolean) => {
      if (!fresh) return;
      const winner = settled.entries[settled.winnerIndex];
      if (!winner) return;

      setAnnouncement(`Winner: ${winner.label}`);

      // The spinner writes the outcome so the result lands exactly once and
      // never before wheels stop elsewhere. If the spinner vanished mid-spin
      // (closed tab, dropped connection), any remaining client that is still
      // allowed to write records it after a grace window; recordResult dedupes
      // by spinId either way. Locked viewers and observers must never mutate a
      // local document with updates the SFU will reject.
      const isSpinner = Boolean(user?.id) && user?.id === settled.spunById;
      const finalizeResult = () => {
        recordResult(doc, {
          spinId: settled.spinId,
          label: winner.label,
          at: Date.now(),
          byName: settled.spunByName,
        });
        if (getRemoveWinnerOnDone(doc)) {
          removeEntryById(doc, winner.id);
        }
      };
      if (!isSpinner && canEditRef.current) {
        const jitteredDelay = RESULT_FAILOVER_MS + Math.random() * 900;
        failoverTimerRef.current = setTimeout(() => {
          failoverTimerRef.current = null;
          const recorded = getHistory(doc).some(
            (result) => result.spinId === settled.spinId
          );
          if (!recorded && canEditRef.current) finalizeResult();
        }, jitteredDelay);
      }

      // Reveal beat: flash the winning slice, then bring in the card. The
      // flash needs the live wheel to still match the snapshot's geometry;
      // if the list changed mid-spin, skip straight to the card.
      const liveEntries = getEntries(doc);
      const flashable =
        liveEntries.length === settled.entries.length &&
        liveEntries[settled.winnerIndex]?.id === winner.id;
      if (flashable) setHighlightIndex(settled.winnerIndex);

      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        setHighlightIndex(null);
        soundsRef.current?.win();
        setOverlaySpin(settled);
        // Recording (and auto-remove) happens after the flash so the slice
        // is visible while it celebrates; both are idempotent if a failover
        // client got there first.
        if (isSpinner && canEditRef.current) finalizeResult();
      }, flashable ? REVEAL_DELAY_MS : 120);
    },
    [doc, user]
  );

  const rosterLabels = useMemo(() => {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const member of participants ?? []) {
      const name = (member.name ?? member.email ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(name);
    }
    return labels;
  }, [participants]);

  const missingParticipantLabels = useMemo(() => {
    const existing = new Set(entries.map((entry) => entry.label.toLowerCase()));
    return rosterLabels.filter((label) => !existing.has(label.toLowerCase()));
  }, [entries, rosterLabels]);

  const handleAddParticipants = useCallback(() => {
    if (missingParticipantLabels.length === 0) return;
    addEntries(doc, missingParticipantLabels);
  }, [doc, missingParticipantLabels]);

  const handleShuffle = useCallback(() => {
    const current = getEntries(doc);
    if (current.length < 2) return;
    const shuffled = [...current];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    replaceEntries(doc, shuffled);
  }, [doc]);

  const handleSort = useCallback(() => {
    const current = getEntries(doc);
    if (current.length < 2) return;
    const sorted = [...current].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
    replaceEntries(doc, sorted);
  }, [doc]);

  const overlayWinner = overlaySpin
    ? overlaySpin.entries[overlaySpin.winnerIndex] ?? null
    : null;
  const overlayWinnerOnWheel = Boolean(
    overlayWinner && entries.some((entry) => entry.id === overlayWinner.id)
  );
  const overlayResultNumber = useMemo(() => {
    if (!overlaySpin) return 1;
    const index = history.findIndex(
      (result) => result.spinId === overlaySpin.spinId
    );
    return index >= 0 ? history.length - index : history.length + 1;
  }, [overlaySpin, history]);

  const showEmptyCta =
    entries.length === 0 && !isSpinning && highlightIndex === null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#0b0b0b] text-[#fafafa] md:flex-row">
      <div className="relative min-h-[300px] flex-1">
        <WheelStage
          entries={entries}
          spin={spin}
          canSpin={canEdit}
          sounds={soundsRef.current}
          reducedMotion={reducedMotion}
          highlightIndex={highlightIndex}
          onRequestSpin={handleRequestSpin}
          onSettled={handleSettled}
          onSpinningChange={setIsSpinning}
        />

        {/* Floating sound toggle keeps the stage otherwise chrome-free. */}
        <button
          type="button"
          onClick={() => setSoundOn((value) => !value)}
          aria-pressed={soundOn}
          title={soundOn ? "Mute wheel sounds" : "Unmute wheel sounds"}
          className="absolute right-3 top-3 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[#a1a1aa] transition-colors hover:border-white/20 hover:text-[#fafafa]"
        >
          {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
        </button>

        {showEmptyCta && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
            <div className="pointer-events-auto flex flex-col items-center gap-2.5 rounded-2xl border border-white/[0.08] bg-[#111114]/95 px-6 py-4 text-center">
              <p className="text-[12.5px] text-[#fafafa]/75">
                {canEdit
                  ? "Add names to spin the wheel"
                  : "Waiting for the host to add names"}
              </p>
              {canEdit && missingParticipantLabels.length > 0 && (
                <button
                  type="button"
                  onClick={handleAddParticipants}
                  className="cursor-pointer rounded-full bg-[#f95f4a] px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Add everyone in the meeting
                </button>
              )}
            </div>
          </div>
        )}

        {overlaySpin && overlayWinner && (
          <WinnerOverlay
            label={overlayWinner.label}
            color={segmentColor(
              overlaySpin.winnerIndex,
              overlaySpin.entries.length
            )}
            byName={overlaySpin.spunByName}
            resultNumber={overlayResultNumber}
            canRemove={canEdit && overlayWinnerOnWheel}
            canSpinAgain={canEdit && entries.length >= 2}
            reducedMotion={reducedMotion}
            onRemove={() => {
              removeEntryById(doc, overlayWinner.id);
            }}
            onSpinAgain={() => {
              setOverlaySpin(null);
              handleRequestSpin();
            }}
            onClose={() => setOverlaySpin(null)}
          />
        )}
      </div>

      <aside className="flex h-[46%] max-h-[380px] w-full shrink-0 flex-col border-t border-white/[0.06] md:h-auto md:max-h-none md:w-[312px] md:border-l md:border-t-0">
        <WheelPanel
          entries={entries}
          history={history}
          canEdit={canEdit}
          locked={locked}
          isAdmin={Boolean(isAdmin)}
          isSpinning={isSpinning}
          removeWinnerOnDone={removeWinnerOnDone}
          missingParticipantCount={missingParticipantLabels.length}
          onAddEntry={(label) => addEntries(doc, [label])}
          onAddEntries={(labels) => addEntries(doc, labels)}
          onAddParticipants={handleAddParticipants}
          onRemoveEntry={(entryId) => removeEntryById(doc, entryId)}
          onShuffle={handleShuffle}
          onSort={handleSort}
          onClearEntries={() => clearEntries(doc)}
          onClearHistory={() => clearHistory(doc)}
          onToggleRemoveWinner={(value) => setRemoveWinnerOnDone(doc, value)}
        />
      </aside>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
