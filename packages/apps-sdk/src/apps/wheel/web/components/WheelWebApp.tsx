import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { WheelSounds } from "../sounds";
import { GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./buttons";
import { WheelPanel } from "./WheelPanel";
import { WheelStage } from "./WheelStage";

const APP_ID = "wheel";
const SOUND_PREF_KEY = "conclave:wheel:sound";

const SPIN_MIN_DURATION_MS = 7200;
const SPIN_DURATION_SPREAD_MS = 1600;
const SPIN_MIN_TURNS = 7;
const SPIN_TURNS_SPREAD = 3;
const REVEAL_DELAY_MS = 800;
const RESULT_FAILOVER_MS = 2600;
const STAGE_PADDING_PX = 16;
const MIN_REVEAL_WHEEL_PX = 96;

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

const readoutSize = (label: string): string => {
  const length = Array.from(label).length;
  const narrow =
    length <= 16
      ? "text-[30px] leading-[38px]"
      : length <= 30
        ? "text-[22px] leading-[28px]"
        : "text-[18px] leading-6";
  return `${narrow} @min-[720px]:text-[30px] @min-[720px]:leading-[38px]`;
};

const readSoundPreference = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "0";
  } catch {
    return true;
  }
};

export function WheelWebApp() {
  const { doc, locked } = useAppDoc(APP_ID);
  const { user, isAdmin, isReadOnly, participants } = useApps();
  const { entries, spin, history, removeWinnerOnDone } = useWheelDocState(doc);

  const canEdit = !isReadOnly && (!locked || Boolean(isAdmin));
  const reducedMotion = useReducedMotion();

  const [isSpinning, setIsSpinning] = useState(false);
  const [landedSpinId, setLandedSpinId] = useState<string | null>(null);
  const [revealedSpinId, setRevealedSpinId] = useState<string | null>(null);
  const [dismissedSpinId, setDismissedSpinId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [soundOn, setSoundOn] = useState(readSoundPreference);

  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveLabelRef = useRef<HTMLSpanElement | null>(null);
  const spinCountRef = useRef(0);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  const frozen = spin && spin.spinId !== dismissedSpinId ? spin : null;
  const landed = Boolean(frozen && !isSpinning && landedSpinId === frozen.spinId);
  const winner = frozen && landed ? frozen.entries[frozen.winnerIndex] ?? null : null;
  const showReveal = Boolean(winner && frozen && revealedSpinId === frozen.spinId);

  const soundsRef = useRef<WheelSounds | null>(null);
  if (soundsRef.current === null && typeof window !== "undefined") {
    soundsRef.current = new WheelSounds();
  }

  useEffect(() => {
    if (soundsRef.current) soundsRef.current.enabled = soundOn;
    try {
      window.localStorage.setItem(SOUND_PREF_KEY, soundOn ? "1" : "0");
    } catch {
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

  const activeSpinId = spin?.spinId;
  useEffect(() => {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (failoverTimerRef.current) {
      clearTimeout(failoverTimerRef.current);
      failoverTimerRef.current = null;
    }
  }, [activeSpinId]);

  const shownSpinId = showReveal && frozen ? frozen.spinId : null;
  const closeReveal = useCallback(() => {
    if (shownSpinId) setDismissedSpinId(shownSpinId);
  }, [shownSpinId]);

  useEffect(() => {
    if (!shownSpinId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReveal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shownSpinId, closeReveal]);

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
      setLandedSpinId(settled.spinId);
      const winner = settled.entries[settled.winnerIndex];
      if (!winner) return;
      spinCountRef.current += 1;
      setAnnouncement(`Spin ${spinCountRef.current} winner: ${winner.label}`);
      if (!fresh) {
        setRevealedSpinId(settled.spinId);
        return;
      }

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

      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        soundsRef.current?.win();
        setRevealedSpinId(settled.spinId);
        if (isSpinner && canEditRef.current) finalizeResult();
      }, REVEAL_DELAY_MS);
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

  const winnerOnWheel = Boolean(
    winner && entries.some((entry) => entry.id === winner.id)
  );
  const canSpin = canEdit && !isSpinning && entries.length >= 2;

  const sectionRef = useRef<HTMLElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [wheelHidden, setWheelHidden] = useState(false);

  useLayoutEffect(() => {
    if (!showReveal) {
      setWheelHidden(false);
      return;
    }
    const section = sectionRef.current;
    const readout = readoutRef.current;
    const footer = footerRef.current;
    if (!section || !readout || !footer) return;
    const update = () => {
      const height = section.clientHeight - readout.offsetHeight - footer.offsetHeight;
      const wheel = Math.min(section.clientWidth, height) - 2 * STAGE_PADDING_PX;
      setWheelHidden(wheel < MIN_REVEAL_WHEEL_PX);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(section);
    observer.observe(readout);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [showReveal]);

  const handlePointerLabel = useCallback((label: string | null) => {
    const element = liveLabelRef.current;
    if (element && label) element.textContent = label;
  }, []);

  return (
    <div className="@container h-full min-h-0 w-full">
      <div
        data-wheel-scroll
        className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[#0a0a0b] text-[#fafafa] @min-[720px]:flex-row @min-[720px]:overflow-visible"
      >
        <section
          ref={sectionRef}
          className={`relative flex min-h-[240px] min-w-0 flex-1 flex-col @min-[720px]:min-h-[260px] ${wheelHidden ? "justify-center" : ""}`}
        >
          <div
            ref={readoutRef}
            className="flex min-h-[62px] shrink-0 flex-col items-center justify-end px-4 pt-2 text-center @min-[720px]:min-h-[76px]"
          >
            <p
              className="h-[38px] max-w-full truncate text-[30px] font-semibold leading-[38px]"
              hidden={!isSpinning}
            >
              <span ref={liveLabelRef} />
            </p>
            {!isSpinning &&
              (winner ? (
                <p
                  data-wheel-readout
                  className={`max-w-full text-balance font-semibold [overflow-wrap:anywhere] ${readoutSize(winner.label)}`}
                >
                  {winner.label}
                </p>
              ) : (
                <div className="h-[38px]" />
              ))}
            <p className="min-h-4 max-w-full text-[12px] leading-4 text-[#fafafa]/55 [overflow-wrap:anywhere]">
              {showReveal && frozen ? `Spun by ${frozen.spunByName}` : null}
            </p>
          </div>

          <div
            aria-hidden={wheelHidden || undefined}
            className={
              wheelHidden
                ? "pointer-events-none relative h-0 min-h-0 flex-none overflow-hidden opacity-0"
                : "relative min-h-0 flex-1 opacity-100 transition-opacity duration-100 ease-out motion-reduce:transition-none"
            }
          >
            <WheelStage
              entries={frozen ? frozen.entries : entries}
              spin={spin}
              canSpin={canEdit}
              sounds={soundsRef.current}
              reducedMotion={reducedMotion}
              highlightIndex={frozen && landed ? frozen.winnerIndex : null}
              onRequestSpin={handleRequestSpin}
              onSettled={handleSettled}
              onSpinningChange={setIsSpinning}
              onPointerLabel={handlePointerLabel}
            />
          </div>

          <div
            ref={footerRef}
            className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 pb-3 pt-1 @min-[720px]:px-4 @min-[720px]:pb-4"
          >
            {showReveal ? (
              <>
                {canEdit && (
                  <button
                    type="button"
                    data-wheel-action="spin-again"
                    onClick={handleRequestSpin}
                    disabled={entries.length < 2}
                    className={`${PRIMARY_BUTTON} w-full @min-[720px]:w-auto`}
                  >
                    Spin again
                  </button>
                )}
                {canEdit && winnerOnWheel && winner && (
                  <button
                    type="button"
                    data-wheel-action="remove-winner"
                    onClick={() => removeEntryById(doc, winner.id)}
                    className={`${SECONDARY_BUTTON} h-9 flex-1 @min-[720px]:h-10 @min-[720px]:flex-none`}
                  >
                    Remove from wheel
                  </button>
                )}
                <button
                  type="button"
                  data-wheel-action="done"
                  onClick={closeReveal}
                  className={`${GHOST_BUTTON} h-9 @min-[720px]:h-10`}
                >
                  Done
                </button>
              </>
            ) : canEdit ? (
              <button
                type="button"
                data-wheel-action="spin"
                onClick={handleRequestSpin}
                disabled={!canSpin || Boolean(frozen)}
                className={`${PRIMARY_BUTTON} w-full @min-[720px]:w-auto @min-[720px]:min-w-40`}
              >
                {isSpinning ? "Spinning" : "Spin"}
              </button>
            ) : null}
          </div>
        </section>

        <aside className="flex h-[44%] min-h-[280px] w-full shrink-0 @min-[720px]:min-h-[200px] flex-col border-t border-white/[0.08] bg-[#111113] @min-[720px]:h-auto @min-[720px]:w-[320px] @min-[720px]:border-l @min-[720px]:border-t-0">
          <WheelPanel
            entries={entries}
            history={history}
            canEdit={canEdit}
            locked={locked}
            isAdmin={Boolean(isAdmin)}
            isSpinning={isSpinning}
            soundOn={soundOn}
            removeWinnerOnDone={removeWinnerOnDone}
            missingParticipantCount={missingParticipantLabels.length}
            onToggleSound={() => setSoundOn((value) => !value)}
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
      </div>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
