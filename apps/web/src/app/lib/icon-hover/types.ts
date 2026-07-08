/**
 * Reactive icon hover animation system — types.
 *
 * Every lucide icon renders `<svg class="lucide lucide-<slug>">` with its glyph
 * parts as ordered children, so we can animate the whole icon or specific parts
 * (by 1-based nth-child index) without touching any component markup.
 */

export type AnimSpec = {
  /**
   * Keyframe name from KEYFRAMES (without the `ai-` prefix) for a one-shot /
   * looping animation. Mutually exclusive with `hold`.
   */
  kf?: string;
  /**
   * A transform to smoothly settle into (and hold) while hovered, e.g.
   * 'scale(1.12)' or 'rotate(90deg)'. Uses a CSS transition rather than a
   * keyframe animation — no bounce, no "pop", just an eased pose that returns
   * on mouse-out. Mutually exclusive with `kf`.
   */
  hold?: string;
  /** duration in seconds (default 0.5 for `kf`, 0.24 for `hold`) */
  dur?: number;
  /** timing function (default 'ease-in-out') */
  ease?: string;
  /** iteration count, e.g. 'infinite' or 2 (default 1) */
  iter?: number | "infinite";
  /** single animation-delay in seconds; prefer `stagger` on PartSpec */
  delay?: number;
  /**
   * transform-box for the animated element:
   *  - 'fill' → transform-origin is relative to the element's own box
   *  - 'view' → transform-origin is in the icon's 24×24 viewBox coords (px)
   * Defaults to 'fill' whenever `origin` is set.
   */
  box?: "fill" | "view";
  /** transform-origin, e.g. '50% 50%', '12px 6px', 'left center' */
  origin?: string;
  /** translate distances consumed by the `nudge` / `nudge-loop` keyframes */
  dx?: string;
  dy?: string;
};

export type PartSpec = AnimSpec & {
  /** which child part(s): 1-based nth-child index, a list, or 'all' */
  on: number | number[] | "all";
  /** per-part animation-delay in seconds, in `on` order */
  stagger?: number[];
};

export type IconDef = {
  /** animate the whole <svg> */
  svg?: AnimSpec;
  /** animate specific child parts */
  parts?: PartSpec[];
};

/** slug (lucide class suffix, e.g. 'audio-lines') → animation definition */
export type IconRegistry = Record<string, IconDef>;

/** keyframe name → body between the `{ }` of `@keyframes ai-<name>` */
export type KeyframeMap = Record<string, string>;
