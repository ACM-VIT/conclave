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

// Native F00 palette. Colors are unsigned 32-bit ARGB numbers, including alpha.
// Keep the existing web exports and `tokens` aggregate independent of this data.
const nativeBrand = {
  coral: 0xFFF95F4A,
  coralDeep: 0xFFB94333,
  coralBright: 0xFFFF7D66,
  coralDeepHighContrast: 0xFF9E3024,
  coralBrightHighContrast: 0xFFFF8C75,
  ink: 0xFF0A0A0B,
  paper: 0xFFFAFAFA,
} as const;

const nativeNeutral = {
  white: 0xFFFFFFFF,
  black: 0xFF000000,
  transparent: 0x00000000,
  zinc50: nativeBrand.paper,
  light1: 0xFFF9F9FA,
  zinc100: 0xFFF4F4F5,
  light3: 0xFFF0F0F2,
  light4: 0xFFECECEF,
  light5: 0xFFDCDCE0,
  zinc200: 0xFFE4E4E7,
  zinc300: 0xFFD4D4D8,
  zinc400: 0xFFA1A1AA,
  zinc500: 0xFF71717A,
  zinc600: 0xFF52525B,
  zinc700: 0xFF3F3F46,
  zinc800: 0xFF27272A,
  zinc900: 0xFF18181B,
  tile: 0xFF131316,
  surfaceRaised: 0xFF232327,
  surfaceHigh: 0xFF2E2E33,
  surfaceBrightDark: 0xFF35353B,
  stage: nativeBrand.ink,
  inkDeep: 0xFF050506,
} as const;

const nativeStatus = {
  light: { success: 0xFF166534, warning: 0xFF92400E, live: 0xFF1D4ED8 },
  dark: { success: 0xFF22C55E, warning: 0xFFFBBF24, live: 0xFF60A5FA },
} as const;

const nativeAndroidLight = {
  primary: nativeBrand.coralDeep,
  onPrimary: nativeNeutral.white,
  primaryContainer: nativeBrand.coral,
  onPrimaryContainer: nativeBrand.ink,
  inversePrimary: nativeBrand.coralBright,
  secondary: nativeNeutral.zinc600,
  onSecondary: nativeNeutral.white,
  secondaryContainer: nativeNeutral.zinc200,
  onSecondaryContainer: nativeNeutral.zinc900,
  tertiary: nativeNeutral.zinc600,
  onTertiary: nativeNeutral.white,
  tertiaryContainer: nativeNeutral.zinc200,
  onTertiaryContainer: nativeNeutral.zinc900,
  background: nativeNeutral.white,
  onBackground: nativeNeutral.zinc900,
  surface: nativeNeutral.white,
  onSurface: nativeNeutral.zinc900,
  surfaceVariant: nativeNeutral.light4,
  onSurfaceVariant: nativeNeutral.zinc600,
  surfaceTint: nativeNeutral.transparent,
  inverseSurface: nativeNeutral.zinc800,
  inverseOnSurface: nativeBrand.paper,
  error: 0xFFBA1A1A,
  onError: nativeNeutral.white,
  errorContainer: 0xFFFFDAD6,
  onErrorContainer: 0xFF93000A,
  outline: nativeNeutral.zinc500,
  outlineVariant: nativeNeutral.zinc200,
  scrim: nativeNeutral.black,
  surfaceBright: nativeNeutral.white,
  surfaceDim: nativeNeutral.light5,
  surfaceContainerLowest: nativeNeutral.white,
  surfaceContainerLow: nativeNeutral.light1,
  surfaceContainer: nativeNeutral.zinc100,
  surfaceContainerHigh: nativeNeutral.light3,
  surfaceContainerHighest: nativeNeutral.light4,
  primaryFixed: 0xFFFFDAD4,
  primaryFixedDim: 0xFFFFB4A8,
  onPrimaryFixed: 0xFF410100,
  onPrimaryFixedVariant: 0xFF8F1107,
  secondaryFixed: nativeNeutral.zinc200,
  secondaryFixedDim: nativeNeutral.zinc300,
  onSecondaryFixed: nativeNeutral.zinc900,
  onSecondaryFixedVariant: nativeNeutral.zinc700,
  tertiaryFixed: nativeNeutral.zinc200,
  tertiaryFixedDim: nativeNeutral.zinc300,
  onTertiaryFixed: nativeNeutral.zinc900,
  onTertiaryFixedVariant: nativeNeutral.zinc700,
} as const;

const nativeAndroidDark = {
  primary: nativeBrand.coralBright,
  onPrimary: nativeBrand.ink,
  primaryContainer: nativeBrand.coral,
  onPrimaryContainer: nativeBrand.ink,
  inversePrimary: nativeBrand.coralDeep,
  secondary: nativeNeutral.zinc400,
  onSecondary: nativeNeutral.zinc900,
  secondaryContainer: nativeNeutral.zinc700,
  onSecondaryContainer: nativeBrand.paper,
  tertiary: nativeNeutral.zinc400,
  onTertiary: nativeNeutral.zinc900,
  tertiaryContainer: nativeNeutral.zinc700,
  onTertiaryContainer: nativeBrand.paper,
  background: nativeBrand.ink,
  onBackground: nativeBrand.paper,
  surface: nativeBrand.ink,
  onSurface: nativeBrand.paper,
  surfaceVariant: nativeNeutral.surfaceHigh,
  onSurfaceVariant: nativeNeutral.zinc400,
  surfaceTint: nativeNeutral.transparent,
  inverseSurface: nativeNeutral.zinc100,
  inverseOnSurface: nativeNeutral.zinc900,
  error: 0xFFFFB4AB,
  onError: 0xFF690005,
  errorContainer: 0xFF93000A,
  onErrorContainer: 0xFFFFDAD6,
  outline: nativeNeutral.zinc500,
  outlineVariant: nativeNeutral.zinc700,
  scrim: nativeNeutral.black,
  surfaceBright: nativeNeutral.surfaceBrightDark,
  surfaceDim: nativeBrand.ink,
  surfaceContainerLowest: nativeNeutral.inkDeep,
  surfaceContainerLow: nativeNeutral.tile,
  surfaceContainer: nativeNeutral.zinc900,
  surfaceContainerHigh: nativeNeutral.surfaceRaised,
  surfaceContainerHighest: nativeNeutral.surfaceHigh,
  primaryFixed: nativeAndroidLight.primaryFixed,
  primaryFixedDim: nativeAndroidLight.primaryFixedDim,
  onPrimaryFixed: nativeAndroidLight.onPrimaryFixed,
  onPrimaryFixedVariant: nativeAndroidLight.onPrimaryFixedVariant,
  secondaryFixed: nativeAndroidLight.secondaryFixed,
  secondaryFixedDim: nativeAndroidLight.secondaryFixedDim,
  onSecondaryFixed: nativeAndroidLight.onSecondaryFixed,
  onSecondaryFixedVariant: nativeAndroidLight.onSecondaryFixedVariant,
  tertiaryFixed: nativeAndroidLight.tertiaryFixed,
  tertiaryFixedDim: nativeAndroidLight.tertiaryFixedDim,
  onTertiaryFixed: nativeAndroidLight.onTertiaryFixed,
  onTertiaryFixedVariant: nativeAndroidLight.onTertiaryFixedVariant,
} as const;

/** Canonical native tokens; generated Swift, asset catalogs and XML consume this
 * namespace directly. Platform semantics (UIKit colors, text styles, system
 * fonts, capsule shapes and iOS green switches) stay in native adapters. */
export const native = {
  brand: nativeBrand,
  neutral: nativeNeutral,
  status: nativeStatus,
  ios: {
    app: {
      // Other App colors, including dark secondaryLabel and systemRed, are
      // dynamic UIKit roles. Do not substitute sampled system hex values.
      textSecondaryLight: 0xFF636366,
      textSecondaryLightHighContrast: 0xFF48484A,
      coralFill: nativeBrand.coral,
      onCoral: nativeBrand.ink,
      onCoralHighContrast: nativeNeutral.black,
      coralTextLight: nativeBrand.coralDeep,
      coralTextDark: nativeBrand.coralBright,
      coralTextLightHighContrast: nativeBrand.coralDeepHighContrast,
      coralTextDarkHighContrast: nativeBrand.coralBrightHighContrast,
      // Static launch colors only; app backgrounds use systemGroupedBackground.
      launchBackgroundLight: 0xFFF2F2F7,
      launchBackgroundDark: nativeNeutral.black,
    },
    inCall: {
      stage: nativeBrand.ink,
      tile: nativeNeutral.tile,
      surface: nativeNeutral.zinc900,
      surfaceRaised: nativeNeutral.surfaceRaised,
      surfaceHigh: nativeNeutral.surfaceHigh,
      text: nativeBrand.paper,
      textSecondary: 0xBDFAFAFA, // 74%, rounded to the nearest alpha byte.
      textSecondaryHighContrast: 0xE6FAFAFA, // 90%
      textTertiary: 0x8FFAFAFA, // 56%
      textTertiaryHighContrast: 0xBDFAFAFA, // 74%
      border: 0x24FAFAFA, // 14%
      borderHighContrast: 0x52FAFAFA, // 32%
      borderStrong: 0x3DFAFAFA, // 24%
      borderStrongHighContrast: 0x66FAFAFA, // 40%
      labelScrim: 0xA3000000, // 64%
      labelScrimHighContrast: 0xCC000000, // 80%
      scrim: 0xB3000000, // 70%
      coralFill: nativeBrand.coral,
      onCoral: nativeBrand.ink,
      onCoralHighContrast: nativeNeutral.black,
      coralText: nativeBrand.coralBright,
      coralTextHighContrast: nativeBrand.coralBrightHighContrast,
      controlOff: nativeBrand.paper,
      onControlOff: nativeBrand.ink,
      controlFallback: nativeNeutral.surfaceRaised,
      success: nativeStatus.dark.success,
      warning: nativeStatus.dark.warning,
      live: nativeStatus.dark.live,
      // Leave remains systemRed under the dark scheme in the iOS adapter.
    },
  },
  android: {
    light: nativeAndroidLight,
    dark: nativeAndroidDark,
    // A separate scheme even while values match dark. It never follows light.
    inCall: { ...nativeAndroidDark },
    extended: {
      successLight: nativeStatus.light.success,
      successDark: nativeStatus.dark.success,
      warningLight: nativeStatus.light.warning,
      warningDark: nativeStatus.dark.warning,
      liveLight: nativeStatus.light.live,
      liveDark: nativeStatus.dark.live,
      onWarningLight: nativeNeutral.white,
      onWarningDark: nativeBrand.ink,
      onLiveLight: nativeNeutral.white,
      onLiveDark: nativeBrand.ink,
      handRaisedLight: nativeStatus.light.warning,
      handRaisedDark: nativeStatus.dark.warning,
      speaking: nativeBrand.coral,
      callEnd: 0xFFEA4335,
      onCallEnd: nativeNeutral.white,
      stage: nativeBrand.ink,
      tile: nativeNeutral.tile,
      labelScrim: 0xA3000000,
      labelScrimHighContrast: 0xCC000000,
      toolbarContainer: nativeNeutral.zinc900,
      toggleOnContainer: nativeNeutral.surfaceHigh,
      onToggleOn: nativeBrand.paper,
      toggleOffContainer: 0xFFF2B8B5,
      onToggleOff: 0xFF601410,
      toggleEngagedContainer: nativeNeutral.zinc100,
      onToggleEngaged: nativeNeutral.zinc900,
      borderLight: 0x14000000, // 8%
      borderDark: 0x24FAFAFA, // 14%
      borderLightHighContrast: 0x52000000, // 32%
      borderDarkHighContrast: 0x52FAFAFA, // 32%
    },
  },
  // Points on iOS, dp on Android. Typography stays in platform text styles.
  space: {
    space2: 2,
    space4: 4,
    space8: 8,
    space12: 12,
    space16: 16,
    space20: 20,
    space24: 24,
    space32: 32,
    space40: 40,
    space48: 48,
  },
  radius: {
    small: 8,
    medium: 12,
    tile: 16,
    bubble: 18,
    sheet: 28,
    bubbleAndroid: 20,
    bubbleTailAndroid: 4,
    extraSmallAndroid: 4,
  },
  avatar: {
    // Identity colors only, never UI accents. Order matches web Facehash.
    palette: [
      nativeBrand.coral, 0xFFFF007A, 0xFF7C5CFF, 0xFF2DA8A8,
      0xFF4F86F7, 0xFF3FA66A, 0xFFF59E0B, 0xFF14B8A6,
      0xFFE879F9, 0xFF38BDF8, 0xFFFF8A3D, 0xFFFB7185,
      0xFFC084FC, 0xFF6366F1, 0xFF10B981, 0xFFFF5EAE,
    ],
    ring: 0x2EFFFFFF, // White at 18%.
  },
} as const;
