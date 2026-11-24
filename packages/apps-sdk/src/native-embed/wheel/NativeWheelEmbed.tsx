import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WheelStage } from "../../apps/wheel/web/components/WheelStage";
import { useWheelDocState } from "../../apps/wheel/web/hooks/useWheelDocState";
import { WheelSounds } from "../../apps/wheel/web/sounds";
import {
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
} from "../../apps/wheel/core/doc/index";
import { APP_EDIT_COMMANDS, isValidIdentifier, type Envelope, type NativeToEmbedType } from "../protocol";
import {
  payloadBoolean,
  payloadString,
  type AppStatusPayload,
  type CommandResult,
  type HostStatus,
  type NativeEmbedSession,
  type WheelAppStatus,
} from "../session";
import { addNames, wheelStatus } from "./commands";

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

  const [isSpinning, setIsSpinning] = useState(false);
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
    const winnerEntry = settled.entries[settled.winnerIndex];
    if (!winnerEntry) return;
    const shown = { spinId: settled.spinId, label: winnerEntry.label };
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

  useEffect(() => {
    if (!reduceMotion || !spin || handledRef.current.has(spin.spinId)) return;
    const remaining = spin.startedAt + spin.durationMs - Date.now();
    if (remaining <= 0) return;
    handledRef.current.add(spin.spinId);
    reveal(spin);
    scheduleFinalize(spin, remaining);
  }, [reduceMotion, spin, reveal, scheduleFinalize]);

  const stageSpin = useMemo<WheelSpin | null>(() => {
    if (!spin || !reduceMotion) return spin;
    return { ...spin, startedAt: Math.min(spin.startedAt, Date.now()) - spin.durationMs };
  }, [spin, reduceMotion]);

  const requestSpin = useCallback((): CommandResult => {
    if (!canEditRef.current) return { ok: false, error: "readOnly" };
    if (isSpinning || revealTimerRef.current) return { ok: false, error: "busy" };
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
  }, [doc, isSpinning]);

  const status = useMemo<WheelAppStatus>(
    () =>
      wheelStatus({ entries, history, removeWinner: removeWinnerOnDone, sounds: soundOn, spinning: isSpinning, winner }),
    [entries, history, removeWinnerOnDone, soundOn, isSpinning, winner],
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
      switch (envelope.type) {
        case "addEntries":
          return addNames(doc, payload);
        case "removeEntry": {
          const entryId = payloadString(payload, "entryId");
          if (!isValidIdentifier(entryId)) return { ok: false, error: "badEntry" };
          removeEntryById(doc, entryId);
          return { ok: true };
        }
        case "shuffle": {
          const current = getEntries(doc);
          if (current.length < 2) return { ok: true };
          const shuffled = [...current];
          for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const other = Math.floor(Math.random() * (index + 1));
            [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
          }
          replaceEntries(doc, shuffled);
          return { ok: true };
        }
        case "sort": {
          const current = getEntries(doc);
          if (current.length < 2) return { ok: true };
          replaceEntries(doc, [...current].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })));
          return { ok: true };
        }
        case "clearEntries":
          clearEntries(doc);
          return { ok: true };
        case "spin":
          return requestSpin();
        case "setRemoveWinner": {
          const value = payloadBoolean(payload, "value");
          if (value === null) return { ok: false, error: "badValue" };
          setRemoveWinnerOnDone(doc, value);
          return { ok: true };
        }
        case "setSounds": {
          const value = payloadBoolean(payload, "value");
          if (value === null) return { ok: false, error: "badValue" };
          setSoundOn(value);
          return respond({ sounds: value });
        }
        case "clearResults":
          clearHistory(doc);
          return { ok: true };
        case "snapshot":
        case "update":
        case "awareness":
        case "status":
        case "resync":
        case "close":
        case "setTool":
        case "setColor":
        case "setStrokeWidth":
        case "setFill":
        case "undo":
        case "redo":
        case "setPage":
        case "addPage":
        case "renamePage":
        case "deletePage":
        case "zoomToFit":
        case "export":
        case "playNow":
        case "enqueue":
        case "request":
        case "approve":
        case "decline":
        case "cancelRequest":
        case "move":
        case "remove":
        default:
          return { ok: false, error: "unknownCommand" };
      }
    };
    session.setCommandHandler(handler);
    return () => {
      session.setCommandHandler(null);
    };
  }, [session, status, doc, requestSpin]);

  return (
    <div className="wheel-page">
      <WheelStage
        entries={entries}
        spin={stageSpin}
        canSpin={canEdit && synced}
        sounds={soundsRef.current}
        reducedMotion={reduceMotion}
        highlightIndex={highlightIndex}
        onRequestSpin={() => {
          requestSpin();
        }}
        onSettled={handleSettled}
        onSpinningChange={setIsSpinning}
      />
      {overlay ? (
        <div className="wheel-winner" aria-hidden="true" onClick={() => setOverlay(null)}>
          <div className="wheel-winner-card">
            <span className="wheel-winner-label">{overlay.label}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
