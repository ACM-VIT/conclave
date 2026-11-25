import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { getSpin, type WheelSpin } from "../../core/doc/index";

export const spinEndsAt = (spin: WheelSpin, firstSeenAt: number): number =>
  Math.min(spin.startedAt, firstSeenAt) + spin.durationMs;

export type SpinLive = { live: boolean; isLive: () => boolean };

export const useSpinLive = (doc: Y.Doc, spin: WheelSpin | null): SpinLive => {
  const seenRef = useRef<{ spinId: string; at: number } | null>(null);

  const endOf = useCallback((current: WheelSpin, now: number): number => {
    if (seenRef.current?.spinId !== current.spinId) seenRef.current = { spinId: current.spinId, at: now };
    return spinEndsAt(current, seenRef.current.at);
  }, []);

  const isLive = useCallback((): boolean => {
    const current = getSpin(doc);
    const now = Date.now();
    return current !== null && now < endOf(current, now);
  }, [doc, endOf]);

  const [liveSpinId, setLiveSpinId] = useState<string | null>(() => (isLive() ? getSpin(doc)?.spinId ?? null : null));

  useLayoutEffect(() => {
    if (!spin) {
      setLiveSpinId(null);
      return;
    }
    const now = Date.now();
    const remaining = endOf(spin, now) - now;
    setLiveSpinId(remaining > 0 ? spin.spinId : null);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setLiveSpinId((current) => (current === spin.spinId ? null : current)), remaining);
    return () => clearTimeout(timer);
  }, [spin, endOf]);

  return { live: spin !== null && liveSpinId === spin.spinId, isLive };
};
