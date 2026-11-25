import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { getSpin, type WheelSpin } from "../../core/doc/index";

export const spinEndsAt = (spin: WheelSpin, firstSeenAt: number): number =>
  Math.min(spin.startedAt, firstSeenAt) + spin.durationMs;

type Sighting = { seenAt: number; remaining: number; ended: boolean };

const SIGHTINGS_KEPT = 4;

export type SpinLive = { live: boolean; isLive: () => boolean };

export const useSpinLive = (doc: Y.Doc, spin: WheelSpin | null): SpinLive => {
  const sightingsRef = useRef(new Map<string, Sighting>());
  const listenersRef = useRef(new Set<() => void>());

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);

  const sightingOf = useCallback((current: WheelSpin): Sighting => {
    const sightings = sightingsRef.current;
    const known = sightings.get(current.spinId);
    if (known) return known;
    const wall = Date.now();
    const sighting = { seenAt: performance.now(), remaining: spinEndsAt(current, wall) - wall, ended: false };
    sightings.set(current.spinId, sighting);
    if (sightings.size > SIGHTINGS_KEPT) sightings.delete(sightings.keys().next().value as string);
    return sighting;
  }, []);

  const liveFor = useCallback(
    (current: WheelSpin | null): boolean => {
      if (!current) return false;
      const sighting = sightingOf(current);
      if (sighting.ended) return false;
      if (performance.now() - sighting.seenAt < sighting.remaining) return true;
      sighting.ended = true;
      queueMicrotask(notify);
      return false;
    },
    [sightingOf, notify]
  );

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const live = useSyncExternalStore(subscribe, () => liveFor(spin), () => false);

  useLayoutEffect(() => {
    if (!spin || !liveFor(spin)) return;
    const sighting = sightingOf(spin);
    const timer = setTimeout(notify, Math.max(0, sighting.remaining - (performance.now() - sighting.seenAt)) + 1);
    return () => clearTimeout(timer);
  }, [spin, liveFor, sightingOf, notify]);

  const isLive = useCallback(() => liveFor(getSpin(doc)), [doc, liveFor]);

  return { live, isLive };
};
