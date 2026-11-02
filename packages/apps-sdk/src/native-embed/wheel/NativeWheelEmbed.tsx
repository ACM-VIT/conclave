// The Spin the Wheel renderer for the native app host (S60 13 c, ACT-8): the SDK wheel drawing, spin animation and a
// flat winner card, nothing else. The names list, Spin, Edit Names, results and settings are native (the card's Spin
// button and the Activities Wheel page) and reach this page as bridge commands; the page answers each with an `ack`
// after sending the status that shows the change, and adds the page data to every status under `app`. Reduce Motion
// arrives in the host status: the wheel then jumps to the result (the shared spin record and everyone else's
// animation are untouched; the result is still recorded only when the spin settles everywhere). Spin sounds are the
// SDK's synthesized WebAudio sounds (no assets); they start only after a spin and honor Wheel Sounds. The winner is
// announced natively ("Winner: %@"), so the card here is hidden from assistive technology. Flat surfaces only.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WheelStage } from "../../apps/wheel/web/components/WheelStage";
import { useWheelDocState } from "../../apps/wheel/web/hooks/useWheelDocState";
import { segmentColor } from "../../apps/wheel/web/palette";
import { WheelSounds } from "../../apps/wheel/web/sounds";
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
} from "../../apps/wheel/core/doc/index";
import { APP_EDIT_COMMANDS, WHEEL_LIMITS, isValidIdentifier, type Envelope, type NativeToEmbedType } from "../protocol";
import {
  payloadBoolean,
  payloadString,
  type AppStatusPayload,
  type CommandResult,
  type HostStatus,
  type NativeEmbedSession,
  type WheelAppStatus,
} from "../session";

// The web's spin timing (WheelWebApp.tsx), so a native spin looks the same on every client.
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

/** The labels of an `addEntries` payload: strings only, trimmed, non-empty, at most one wheel's worth. */
const labelsFrom = (payload: Record<string, unknown>): string[] => {
  const raw = payload.labels;
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const value of raw as unknown[]) {
    if (typeof value !== "string") continue;
    const label = value.replace(/\s+/g, " ").trim().slice(0, WHEEL_LIMITS.label);
    if (label.length > 0) labels.push(label);
    if (labels.length >= WHEEL_LIMITS.entries) break;
  }
  return labels;
};

type Winner = { spinId: string; label: string; color: string };

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

  // A new spin from anyone replaces whatever ceremony is on screen.
  const activeSpinId = spin?.spinId;
  useEffect(() => {
    setOverlay(null);
    setHighlightIndex(null);
    clearTimers();
  }, [activeSpinId, clearTimers]);

  /** Records the result once (the spinner, or after a grace window any other editor); recordResult dedupes by spin. */
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
    const shown = { spinId: settled.spinId, label: winnerEntry.label, color: segmentColor(settled.winnerIndex, settled.entries.length) };
    setHighlightIndex(null);
    soundsRef.current?.win();
    setOverlay(shown);
    setWinner(shown);
  }, []);

  // The live settle (WheelStage animated it here): flash the slice, then the card; the spinner records the result.
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

  // Reduce Motion: show the result at once, but record it only when the spin settles for everyone.
  useEffect(() => {
    if (!reduceMotion || !spin || handledRef.current.has(spin.spinId)) return;
    const remaining = spin.startedAt + spin.durationMs - Date.now();
    if (remaining <= 0) return;
    handledRef.current.add(spin.spinId);
    reveal(spin);
    scheduleFinalize(spin, remaining);
  }, [reduceMotion, spin, reveal, scheduleFinalize]);

  // With Reduce Motion the stage gets the record as if it had already settled, so it rests on the winner at once
  // (WheelStage reports that settle as not fresh; the effect above handles the result).
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
    () => ({
      kind: "wheel",
      entries: entries
        .filter((entry) => isValidIdentifier(entry.id))
        .slice(0, WHEEL_LIMITS.entries)
        .map((entry) => ({ id: entry.id, label: entry.label.slice(0, WHEEL_LIMITS.label) })),
      results: history
        .filter((result) => isValidIdentifier(result.spinId) && result.label.trim().length > 0)
        .slice(0, WHEEL_LIMITS.results)
        .map((result) => ({
          id: result.spinId,
          label: result.label.slice(0, WHEEL_LIMITS.label),
          byName: result.byName.slice(0, WHEEL_LIMITS.name),
        })),
      removeWinner: removeWinnerOnDone,
      sounds: soundOn,
      spinning: isSpinning,
      winnerSpinId: winner && isValidIdentifier(winner.spinId) ? winner.spinId : "",
      winnerLabel: winner ? winner.label.slice(0, WHEEL_LIMITS.label) : "",
    }),
    [entries, history, removeWinnerOnDone, soundOn, isSpinning, winner],
  );

  // Nothing is reported before the room snapshot: an empty pre-sync wheel would read as "No names yet." natively.
  useEffect(() => {
    if (!synced) return;
    const payload: AppStatusPayload = { app: status };
    session.sendStatus(payload);
  }, [session, status, synced]);

  // Host commands. Each one applies, sends the status that shows it, then returns for the ack.
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
        case "addEntries": {
          const labels = labelsFrom(payload);
          if (labels.length === 0) return { ok: false, error: "noNames" };
          if (getEntries(doc).length >= WHEEL_LIMITS.entries) return { ok: false, error: "full" };
          addEntries(doc, labels);
          return { ok: true };
        }
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
        // Relay messages and commands for another app retain the same rejection as unknown commands.
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
            <span className="wheel-winner-swatch" style={{ backgroundColor: overlay.color }} />
            <span className="wheel-winner-label">{overlay.label}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
