import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as Y from "yjs";
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
  getSpin,
  recordResult,
  removeEntryById,
  reorderEntries,
  setRemoveWinnerOnDone,
  slotLabel,
  startSpin,
  type WheelSpin,
} from "../../core/doc/index";
import { useSpinLive } from "../hooks/useSpinLive";
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
const MIN_WHEEL_PX = 96;
const SIDE_MIN_WIDTH = 720;
const SIDE_MIN_HEIGHT = 300;
const LANDSCAPE_MIN_WIDTH = 560;
const LANDSCAPE_PANEL_PX = 280;
const LANDSCAPE_ACTIONS_PX = 220;
const STACK_REVEAL_CONTROLS_PX = 196;

type WheelLayout = "side" | "landscape" | "stack";

const landscapeWheel = (width: number, height: number): number =>
  Math.min(width - LANDSCAPE_PANEL_PX - LANDSCAPE_ACTIONS_PX, height) - 2 * STAGE_PADDING_PX;

const stackWheel = (height: number): number =>
  Math.max(height * 0.56, Math.min(240, height)) - STACK_REVEAL_CONTROLS_PX - 2 * STAGE_PADDING_PX;

const layoutFor = (width: number, height: number): WheelLayout => {
  if (width >= SIDE_MIN_WIDTH && height >= SIDE_MIN_HEIGHT) return "side";
  if (width < LANDSCAPE_MIN_WIDTH) return "stack";
  const stack = stackWheel(height);
  return stack >= MIN_WHEEL_PX && stack >= landscapeWheel(width, height) ? "stack" : "landscape";
};

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

const readoutSize = (label: string, roomy: boolean): string => {
  const length = Array.from(label).length;
  if (roomy || length <= 16) return "text-[30px] leading-[38px]";
  return length <= 30 ? "text-[22px] leading-[28px]" : "text-[18px] leading-6";
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
  const { user, isAdmin, isReadOnly, participants, documents } = useApps();
  const { entries, waitingCount, spin, history, removeWinnerOnDone } = useWheelDocState(doc);

  const canEdit = !isReadOnly && (!locked || Boolean(isAdmin));
  const reducedMotion = useReducedMotion();

  const [isSpinning, setIsSpinning] = useState(false);
  const { live: spinLive, isLive } = useSpinLive(doc, spin);
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
  const winnerLabel = frozen && winner ? slotLabel(frozen, frozen.winnerIndex) : "";
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
    if (!canEdit || isLive() || isSpinning || revealTimerRef.current) return;
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
  }, [canEdit, isLive, isSpinning, doc, user]);

  const handleSettled = useCallback(
    (settled: WheelSpin, fresh: boolean) => {
      setLandedSpinId(settled.spinId);
      const winner = settled.entries[settled.winnerIndex];
      if (!winner) return;
      const isSpinner = Boolean(user?.id) && user?.id === settled.spunById;
      const isRecordedIn = (target: Y.Doc) =>
        getHistory(target).some((result) => result.spinId === settled.spinId);
      const recorded = () => isRecordedIn(doc);
      const finalizeResult = () =>
        documents.writeOnce(APP_ID, `result:${settled.spinId}`, (live) => {
          if (getSpin(live)?.spinId !== settled.spinId || isRecordedIn(live)) return;
          recordResult(live, {
            spinId: settled.spinId,
            label: winner.label,
            at: Date.now(),
            byName: settled.spunByName,
          });
          if (getRemoveWinnerOnDone(live)) removeEntryById(live, winner.id);
        });
      spinCountRef.current += 1;
      setAnnouncement(`Spin ${spinCountRef.current} winner: ${slotLabel(settled, settled.winnerIndex)}`);
      if (!fresh) {
        setRevealedSpinId(settled.spinId);
        if (isSpinner && canEditRef.current && !recorded()) finalizeResult();
        return;
      }

      if (!isSpinner && canEditRef.current) {
        const jitteredDelay = RESULT_FAILOVER_MS + Math.random() * 900;
        failoverTimerRef.current = setTimeout(() => {
          failoverTimerRef.current = null;
          if (!recorded() && canEditRef.current) finalizeResult();
        }, jitteredDelay);
      }

      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        soundsRef.current?.win();
        setRevealedSpinId(settled.spinId);
        if (isSpinner && canEditRef.current) finalizeResult();
      }, REVEAL_DELAY_MS);
    },
    [doc, user, documents]
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
    if (isLive()) return;
    const current = getEntries(doc);
    if (current.length < 2) return;
    const shuffled = [...current];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    reorderEntries(doc, shuffled);
  }, [doc, isLive]);

  const handleSort = useCallback(() => {
    if (isLive()) return;
    const current = getEntries(doc);
    if (current.length < 2) return;
    const sorted = [...current].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
    reorderEntries(doc, sorted);
  }, [doc, isLive]);

  const winnerOnWheel = Boolean(
    winner && entries.some((entry) => entry.id === winner.id)
  );
  const canSpin = canEdit && !isSpinning && entries.length >= 2;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<WheelLayout>("stack");
  const [wheelHidden, setWheelHidden] = useState(false);
  const [controlsHeight, setControlsHeight] = useState(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const box = root.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setLayout(layoutFor(box.width, box.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const readout = readoutRef.current;
    const footer = footerRef.current;
    if (!section || !readout || !footer) return;
    const actions = actionsRef.current;
    const update = () => {
      const box = section.getBoundingClientRect();
      const controls =
        readout.getBoundingClientRect().height + footer.getBoundingClientRect().height;
      const width =
        layout === "landscape" ? box.width - LANDSCAPE_ACTIONS_PX : box.width;
      const height = layout === "landscape" ? box.height : box.height - controls;
      setControlsHeight(Math.ceil(controls));
      setWheelHidden(Math.min(width, height) - 2 * STAGE_PADDING_PX < MIN_WHEEL_PX);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(section);
    observer.observe(readout);
    observer.observe(footer);
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [layout]);

  const handlePointerLabel = useCallback((label: string | null) => {
    const element = liveLabelRef.current;
    if (!element) return;
    element.textContent = label ?? "Spinning…";
    element.toggleAttribute("data-pending", label === null);
  }, []);

  const roomy = layout === "side";

  const readoutElement = (
    <div
      ref={readoutRef}
      className={`order-1 flex shrink-0 flex-col items-center justify-end text-center ${
        layout === "landscape" ? "min-h-[62px] w-full" : roomy ? "min-h-[76px] px-4 pt-2" : "min-h-[62px] px-4 pt-2"
      }`}
    >
      <p
        className="h-[38px] max-w-full truncate text-[30px] font-semibold leading-[38px]"
        hidden={!isSpinning}
      >
        <span
          ref={liveLabelRef}
          className="data-[pending]:text-[20px] data-[pending]:font-medium data-[pending]:text-[#fafafa]/55"
        />
      </p>
      {!isSpinning &&
        (winner ? (
          <p
            data-wheel-readout
            className={`max-w-full text-balance font-semibold [overflow-wrap:anywhere] ${readoutSize(winnerLabel, roomy)}`}
          >
            {winnerLabel}
          </p>
        ) : (
          <div className="h-[38px]" />
        ))}
      <p className="line-clamp-2 min-h-4 max-w-full text-[12px] leading-4 text-[#fafafa]/55 [overflow-wrap:anywhere]">
        {showReveal && frozen ? `Spun by ${frozen.spunByName}` : null}
      </p>
    </div>
  );

  const wheelElement = (
    <div
      aria-hidden={wheelHidden || undefined}
      className={
        wheelHidden
          ? "hidden"
          : `relative min-h-0 min-w-0 flex-1 transition-opacity duration-100 ease-out starting:opacity-0 motion-reduce:transition-none ${layout === "landscape" ? "" : "order-2"}`
      }
    >
      <WheelStage
        entries={frozen ? frozen.entries : entries}
        listEntries={entries}
        spin={spin}
        canSpin={canEdit && entries.length >= 2 && (!frozen || showReveal)}
        sounds={soundsRef.current}
        reducedMotion={reducedMotion}
        highlightIndex={frozen && landed ? frozen.winnerIndex : null}
        onRequestSpin={handleRequestSpin}
        onSettled={handleSettled}
        onSpinningChange={setIsSpinning}
        onPointerLabel={handlePointerLabel}
      />
    </div>
  );

  const footerElement = (
    <div
      ref={footerRef}
      className={`order-3 flex shrink-0 flex-wrap items-center justify-center gap-2 ${
        layout === "landscape" ? "w-full pt-3" : roomy ? "px-4 pb-4 pt-1" : "px-3 pb-3 pt-1"
      }`}
    >
      {showReveal ? (
        <>
          {canEdit && (
            <button
              type="button"
              data-wheel-action="spin-again"
              onClick={handleRequestSpin}
              disabled={entries.length < 2}
              className={`${PRIMARY_BUTTON} ${roomy ? "" : "w-full"}`}
            >
              Spin again
            </button>
          )}
          {canEdit && winnerOnWheel && winner && (
            <button
              type="button"
              data-wheel-action="remove-winner"
              onClick={() => removeEntryById(doc, winner.id)}
              className={`${SECONDARY_BUTTON} ${roomy ? "" : "h-9 flex-1"}`}
            >
              Remove from wheel
            </button>
          )}
          <button
            type="button"
            data-wheel-action="done"
            onClick={closeReveal}
            className={`${GHOST_BUTTON} ${roomy ? "" : "h-9"}`}
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
          className={`${PRIMARY_BUTTON} ${roomy ? "min-w-40" : "w-full"}`}
        >
          {isSpinning ? "Spinning" : "Spin"}
        </button>
      ) : null}
    </div>
  );

  const panel = (
    <WheelPanel
      fill={roomy}
      entries={entries}
      waitingCount={waitingCount}
      history={history}
      canEdit={canEdit}
      locked={locked}
      isAdmin={Boolean(isAdmin)}
      isSpinning={spinLive}
      soundOn={soundOn}
      removeWinnerOnDone={removeWinnerOnDone}
      missingParticipantCount={missingParticipantLabels.length}
      onToggleSound={() => setSoundOn((value) => !value)}
      onAddEntries={(labels) => addEntries(doc, labels)}
      onAddParticipants={handleAddParticipants}
      onRemoveEntry={(entryId) => {
        if (!isLive()) removeEntryById(doc, entryId);
      }}
      onShuffle={handleShuffle}
      onSort={handleSort}
      onClearEntries={() => {
        if (!isLive()) clearEntries(doc);
      }}
      onClearHistory={() => clearHistory(doc)}
      onToggleRemoveWinner={(value) => setRemoveWinnerOnDone(doc, value)}
    />
  );

  const sectionClass =
    layout === "landscape"
      ? "relative flex min-w-0 flex-1 flex-row"
      : `relative flex flex-col ${roomy ? "min-h-0 min-w-0 flex-1 overflow-y-auto" : "h-[56%] w-full flex-none"} ${wheelHidden ? "justify-center-safe" : ""}`;
  const asideClass =
    layout === "landscape"
      ? "h-full w-[280px] shrink-0 overflow-y-auto border-l"
      : roomy
        ? "flex h-full w-[320px] shrink-0 flex-col border-l"
        : "w-full flex-none border-t";

  return (
    <div ref={rootRef} data-wheel-root className="h-full min-h-0 w-full">
      <div
        data-wheel-scroll={layout === "stack" ? "" : undefined}
        className={`flex h-full min-h-0 w-full bg-[#0a0a0b] text-[#fafafa] ${
          layout === "stack" ? "flex-col overflow-y-auto" : "flex-row"
        }`}
      >
        <section
          ref={sectionRef}
          className={sectionClass}
          style={
            layout === "stack"
              ? { minHeight: `max(min(240px, 100%), ${controlsHeight}px)` }
              : undefined
          }
        >
          {wheelElement}
          <div
            ref={actionsRef}
            className={
              layout === "landscape"
                ? `flex flex-col items-center justify-center-safe overflow-y-auto px-3 py-3 ${wheelHidden ? "min-w-0 flex-1" : "w-[220px] shrink-0"}`
                : "contents"
            }
          >
            {readoutElement}
            {footerElement}
          </div>
        </section>
        <aside className={`${asideClass} border-white/[0.08] bg-[#111113]`}>{panel}</aside>
      </div>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
