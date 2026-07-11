/**
 * @conclave/ui-tokens — THE single source of truth for color, spacing, radii,
 * type scale, border weights, and motion across the TypeScript surfaces.
 *
 * Design laws baked into the shape of this file:
 *  - ONE sans family (no `mono` key — monospace is gone).
 *  - NO shadow / elevation / glow keys exist (their absence is structural).
 *  - Motion is capped at "fast" (<=120ms); there is no slow/decorative tier.
 *
 * Values are derived from the existing ACM-VIT brand hues that used to be
 * duplicated across globals.css @theme, mobile global.css, the --mobile-* vars,
 * and the per-component COLORS objects. They now live here once.
 */

/** Semantic color tokens. Solid hex where possible so Tailwind opacity
 * modifiers (e.g. `bg-accent/15`) work. */
export const color = {
  // Backgrounds & surfaces (dark theme only)
  bg: "#0a0a0b",
  bgAlt: "#131316",
  surface: "#18181b",
  surfaceRaised: "#232327",
  surfaceHover: "#2e2e33",

  // Text (solid + pre-mixed alphas where utilities cannot apply opacity)
  text: "#fafafa",
  textMuted: "rgba(250, 250, 250, 0.74)",
  textFaint: "rgba(250, 250, 250, 0.56)",

  // Accents
  accent: "#F95F4A",
  accentSoft: "rgba(249, 95, 74, 0.2)",
  accentSecondary: "#FF007A",
  /** Active-speaker border — flat, never a glow. */
  speaking: "#F95F4A",

  // Status
  danger: "#ea4335",
  dangerSoft: "rgba(234, 67, 53, 0.15)",
  warning: "#fbbf24",
  success: "#22c55e",

  // Lines & scrims
  border: "rgba(250, 250, 250, 0.14)",
  borderStrong: "rgba(250, 250, 250, 0.24)",
  scrim: "rgba(0, 0, 0, 0.7)",
  scrimSoft: "rgba(0, 0, 0, 0.45)",
} as const;

/** Spacing scale in px. Web uses Tailwind's own spacing scale (we do not
 * override it to avoid clobbering existing utilities). */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
} as const;

/** Corner radii in px. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  /** Standard video tile / card. */
  tile: 16,
  /** Fully-rounded pills & circular control buttons. */
  pill: 999,
} as const;

/** Font families. The single sans is PolySans; `display` (Bulky Wide) is the
 * only expressive face, for headings only. NO mono key by design. */
export const font = {
  sans: '"PolySans Trial", system-ui, -apple-system, sans-serif',
  display: '"PolySans Bulky Wide", sans-serif',
} as const;

/** Type scale — platform-agnostic sizes/weights. Each surface composes these
 * into CSS classes or inline styles. All sans. */
export const text = {
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.2 },
  heading: { fontSize: 18, fontWeight: "700", letterSpacing: 0 },
  body: { fontSize: 15, fontWeight: "400", letterSpacing: 0 },
  label: { fontSize: 13, fontWeight: "500", letterSpacing: 0.2 },
  caption: { fontSize: 11, fontWeight: "500", letterSpacing: 0.4 },
} as const;

/** Border weights in px. */
export const border = {
  hairline: 1,
  /** Active-speaker / selected emphasis. */
  thick: 2,
} as const;

/** Opacity tokens. */
export const opacity = {
  muted: 0.6,
  faint: 0.4,
  soft: 0.15,
  disabled: 0.35,
} as const;

/** Motion durations in ms. Only an instant and a single fast tier exist —
 * there is deliberately no slow/decorative duration. */
export const motion = {
  instant: 0,
  fast: 120,
} as const;

export const tokens = {
  color,
  space,
  radius,
  font,
  text,
  border,
  opacity,
  motion,
} as const;

export type Tokens = typeof tokens;
export type ColorToken = keyof typeof color;
