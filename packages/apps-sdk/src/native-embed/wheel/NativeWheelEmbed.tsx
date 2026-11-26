import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WheelStage } from "../../apps/wheel/web/components/WheelStage";
import { useSpinLive } from "../../apps/wheel/web/hooks/useSpinLive";
import { useWheelDocState } from "../../apps/wheel/web/hooks/useWheelDocState";
import { WheelSounds } from "../../apps/wheel/web/sounds";
import {
  createEntryId,
  getEntries,
  getHistory,
  getRemoveWinnerOnDone,
  recordResult,
  removeEntryById,
  slotLabel,
  startSpin,
  type WheelSpin,
} from "../../apps/wheel/core/doc/index";
import { APP_EDIT_COMMANDS, type Envelope, type NativeToEmbedType } from "../protocol";
import {
  type AppStatusPayload,
  type CommandResult,
  type HostStatus,
  type NativeEmbedSession,
  type WheelAppStatus,
} from "../session";
import { runWheelCommand, wheelStatus } from "./commands";

const SPIN_MIN_DURATION_MS = 7200;
const SPIN_DURATION_SPREAD_MS = 1600;
const SPIN_MIN_TURNS = 7;
const SPIN_TURNS_SPREAD = 3;
const REVEAL_DELAY_MS = 800;
const RESULT_FAILOVER_MS = 2600;

const EDIT_COMMANDS: ReadonlySet<string> = new Set<string>(APP_EDIT_COMMANDS);

const useHostStatus = (session: NativeEmbedSession): HostStatus =>
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.hostStatus,
  );

const useSynced = (session: NativeEmbedSession): boolean =>
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.isSynced,
  );

type Winner = { spinId: string; label: string };

export function NativeWheelEmbed({ session }: { session: NativeEmbedSession }) {
  const { doc } = session;
  const host = useHostStatus(session);
  const synced = useSynced(session);
  const canEdit = !host.readOnly;
  const reduceMotion = host.reduceMotion;
  const { entries, spin, history, removeWinnerOnDone } = useWheelDocState(doc);

  const { live, isLive } = useSpinLive(doc, spin);
  const [animating, setAnimating] = useState(false);
  const [resultSpinId, setResultSpinId] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [winner, setWinner] = useState<Winner | null>(null);
  const [overlay, setOverlay] = useState<Winner | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledRef = useRef<Set<string>>(new Set());
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const hostRef = useRef(host);
  hostRef.current = host;

  const soundsRef = useRef<WheelSounds | null>(null);
  if (soundsRef.current === null && typeof window !== "undefined") {
    soundsRef.current = new WheelSounds();
  }

  useEffect(() => {
    if (soundsRef.current) soundsRef.current.enabled = soundOn;
  }, [soundOn]);

  const clearTimers = useCallback(() => {
    for (const ref of [revealTimerRef, finalizeTimerRef, failoverTimerRef]) {
      if (ref.current) clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  useEffect(() => {
    const sounds = soundsRef.current;
    return () => {
      sounds?.dispose();
      clearTimers();
    };
  }, [clearTimers]);

  const activeSpinId = spin?.spinId;
  useEffect(() => {
    setOverlay(null);
    setHighlightIndex(null);
    clearTimers();
  }, [activeSpinId, clearTimers]);

  const scheduleFinalize = useCallback(
    (settled: WheelSpin, delayMs: number) => {
      const winnerEntry = settled.entries[settled.winnerIndex];
      if (!winnerEntry) return;
      const finalize = () => {
        recordResult(doc, { spinId: settled.spinId, label: winnerEntry.label, at: Date.now(), byName: settled.spunByName });
        if (getRemoveWinnerOnDone(doc)) removeEntryById(doc, winnerEntry.id);
      };
      const isSpinner = hostRef.current.userId !== "" && hostRef.current.userId === settled.spunById;
      if (isSpinner) {
        finalizeTimerRef.current = setTimeout(() => {
          finalizeTimerRef.current = null;
          if (canEditRef.current) finalize();
        }, Math.max(0, delayMs));
      } else {
        failoverTimerRef.current = setTimeout(() => {
          failoverTimerRef.current = null;
          const recorded = getHistory(doc).some((result) => result.spinId === settled.spinId);
          if (!recorded && canEditRef.current) finalize();
        }, Math.max(0, delayMs) + RESULT_FAILOVER_MS + Math.random() * 900);
      }
    },
    [doc],
  );

  const reveal = useCallback((settled: WheelSpin) => {
    if (!settled.entries[settled.winnerIndex]) return;
    const shown = { spinId: settled.spinId, label: slotLabel(settled, settled.winnerIndex) };
    setHighlightIndex(null);
    soundsRef.current?.win();
    setOverlay(shown);
    setWinner(shown);
  }, []);

  const handleSettled = useCallback(
    (settled: WheelSpin, fresh: boolean) => {
      if (!fresh || handledRef.current.has(settled.spinId)) return;
      handledRef.current.add(settled.spinId);
      const winnerEntry = settled.entries[settled.winnerIndex];
      if (!winnerEntry) return;
      setResultSpinId(settled.spinId);
      const liveEntries = getEntries(doc);
      const flashable = liveEntries.length === settled.entries.length && liveEntries[settled.winnerIndex]?.id === winnerEntry.id;
      if (flashable) setHighlightIndex(settled.winnerIndex);
      const delay = flashable ? REVEAL_DELAY_MS : 120;
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        reveal(settled);
      }, delay);
      scheduleFinalize(settled, delay);
    },
    [doc, reveal, scheduleFinalize],
  );

  const requestSpin = useCallback((): CommandResult => {
    if (!canEditRef.current) return { ok: false, error: "readOnly" };
    if (isLive() || animating || revealTimerRef.current) return { ok: false, error: "busy" };
    const liveEntries = getEntries(doc);
    if (liveEntries.length < 2) return { ok: false, error: "notEnoughNames" };
    const current = hostRef.current;
    const record: WheelSpin = {
      spinId: createEntryId(),
      entries: liveEntries,
      winnerIndex: Math.floor(Math.random() * liveEntries.length),
      startedAt: Date.now(),
      durationMs: SPIN_MIN_DURATION_MS + Math.round(Math.random() * SPIN_DURATION_SPREAD_MS),
      turns: SPIN_MIN_TURNS + Math.floor(Math.random() * SPIN_TURNS_SPREAD),
      jitter: 0.15 + Math.random() * 0.7,
      spunById: current.userId || "unknown",
      spunByName: current.userName || "Someone",
    };
    startSpin(doc, record);
    return { ok: true };
  }, [doc, isLive, animating]);

  const status = useMemo<WheelAppStatus>(
    () =>
      wheelStatus({ entries, history, removeWinner: removeWinnerOnDone, sounds: soundOn, spinning: live, winner }),
    [entries, history, removeWinnerOnDone, soundOn, live, winner],
  );

  useEffect(() => {
    if (!synced) return;
    const payload: AppStatusPayload = { app: status };
    session.sendStatus(payload);
  }, [session, status, synced]);

  useEffect(() => {
    const respond = (next: Partial<WheelAppStatus>): CommandResult => {
      session.sendStatus({ app: { ...status, ...next } });
      return { ok: true };
    };
    const handler = (envelope: Envelope<NativeToEmbedType>): CommandResult => {
      const payload = envelope.payload;
      if (!session.isSynced && envelope.type !== "setSounds") return { ok: false, error: "notSynced" };
      if (EDIT_COMMANDS.has(envelope.type) && !canEditRef.current) return { ok: false, error: "readOnly" };
      return runWheelCommand(doc, envelope.type, payload, {
        requestId: envelope.requestId,
        addKey: (requestId) => `${session.scope.appSessionId}/${requestId}`,
        spinning: isLive(),
        requestSpin,
        setSounds: (value) => {
          setSoundOn(value);
          return respond({ sounds: value });
        },
      });
    };
    session.start(handler);
  }, [session, status, doc, requestSpin, isLive]);

  const dialEntries = spin && (live || resultSpinId === spin.spinId) ? spin.entries : entries;

  return (
    <div className="wheel-page">
      <WheelStage
        entries={dialEntries}
        spin={spin}
        canSpin={canEdit && synced}
        sounds={soundsRef.current}
        reducedMotion={reduceMotion}
        highlightIndex={highlightIndex}
        onRequestSpin={() => {
          requestSpin();
        }}
        onSettled={handleSettled}
        onSpinningChange={setAnimating}
      />
      {overlay ? (
        <div
          className="wheel-winner"
          aria-hidden="true"
          onClick={() => {
            setOverlay(null);
            setResultSpinId(null);
          }}
        >
          <div className="wheel-winner-card">
            <span className="wheel-winner-label">{overlay.label}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
