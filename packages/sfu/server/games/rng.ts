import { randomBytes } from "node:crypto";
import type { GameRng } from "./types.js";

/**
 * Small, fast, seedable PRNG (mulberry32). We seed it from crypto so deals and
 * shuffles are unpredictable to clients, but keep it deterministic given a seed
 * so a session could be replayed for debugging.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const createSeed = (): number => randomBytes(4).readUInt32LE(0);

export const createRng = (seed: number = createSeed()): GameRng => {
  const next = mulberry32(seed);
  const int = (maxExclusive: number): number => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive);
  };
  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
      }
      return copy;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error("Cannot pick from an empty list");
      }
      return items[int(items.length)];
    },
  };
};
