import type { AnimSpec, IconDef, PartSpec } from "./types";

/**
 * Terse builders for icon animation entries.
 *
 *   whole(kf, opts)        → animate the whole <svg>
 *   part(on, kf, opts)     → a single PartSpec (on = nth-child index | list | 'all')
 *   parts(...partSpecs)    → wrap PartSpecs into an IconDef
 *   merge(defA, defB, ...) → combine defs (e.g. a whole() with parts())
 */

type Opts = Omit<AnimSpec, "kf">;
type PartOpts = Omit<PartSpec, "kf" | "on">;

export const whole = (kf: string, opts: Opts = {}): IconDef => ({ svg: { kf, ...opts } });

export const part = (on: PartSpec["on"], kf: string, opts: PartOpts = {}): PartSpec => ({
  on,
  kf,
  ...opts,
});

/** Smoothly settle the whole <svg> into `transform` while hovered (no bounce). */
export const hold = (transform: string, opts: Omit<Opts, "kf" | "hold"> = {}): IconDef => ({
  svg: { hold: transform, ...opts },
});

/** Smoothly settle specific part(s) into `transform` while hovered. */
export const holdPart = (
  on: PartSpec["on"],
  transform: string,
  opts: Omit<PartOpts, "kf" | "hold"> = {},
): PartSpec => ({ on, hold: transform, ...opts });

export const parts = (...specs: PartSpec[]): IconDef => ({ parts: specs });

export function merge(...defs: IconDef[]): IconDef {
  const out: IconDef = {};
  for (const d of defs) {
    if (d.svg) out.svg = d.svg;
    if (d.parts) out.parts = [...(out.parts ?? []), ...d.parts];
  }
  return out;
}
