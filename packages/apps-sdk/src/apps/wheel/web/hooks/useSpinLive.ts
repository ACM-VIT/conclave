import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { getSpin, type WheelSpin } from "../../core/doc/index";
import { isSpinRunning, spinRemaining } from "../spinTimeline";

export type SpinLive = { live: boolean; isLive: () => boolean };

export const useSpinLive = (doc: Y.Doc, spin: WheelSpin | null): SpinLive => {
  const listenersRef = useRef(new Set<() => void>());

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const live = useSyncExternalStore(subscribe, () => isSpinRunning(spin), () => false);

  useLayoutEffect(() => {
    if (!spin || !isSpinRunning(spin)) return;
    const timer = setTimeout(() => {
      for (const listener of listenersRef.current) listener();
    }, spinRemaining(spin) + 1);
    return () => clearTimeout(timer);
  }, [spin]);

  const isLive = useCallback(() => isSpinRunning(getSpin(doc)), [doc]);

  return { live, isLive };
};
