import type { WheelSpin } from "../core/doc/index";

export const MIN_VISIBLE_TAIL_MS = 1500;

type Sighting = { elapsedAtSight: number; seenAt: number };

const sightings = new WeakMap<WheelSpin, Sighting>();

const sightingOf = (spin: WheelSpin): Sighting => {
  const known = sightings.get(spin);
  if (known) return known;
  const wall = Date.now();
  const sinceStart = wall - Math.min(spin.startedAt, wall);
  const elapsedAtSight =
    sinceStart >= spin.durationMs
      ? spin.durationMs
      : Math.min(sinceStart, Math.max(0, spin.durationMs - MIN_VISIBLE_TAIL_MS));
  const sighting = { elapsedAtSight, seenAt: performance.now() };
  sightings.set(spin, sighting);
  return sighting;
};

export const spinElapsed = (spin: WheelSpin): number => {
  const sighting = sightingOf(spin);
  return sighting.elapsedAtSight + (performance.now() - sighting.seenAt);
};

export const spinRemaining = (spin: WheelSpin): number => Math.max(0, spin.durationMs - spinElapsed(spin));

export const isSpinRunning = (spin: WheelSpin | null): boolean => spin !== null && spinRemaining(spin) > 0;
