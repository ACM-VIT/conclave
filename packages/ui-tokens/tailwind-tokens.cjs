/**
 * CommonJS bridge of @conclave/ui-tokens for NativeWind's tailwind.config.js,
 * which is evaluated by plain Node and cannot load the TS source (tokens.ts).
 *
 * KEEP IN SYNC with src/tokens.ts (color / radius / font) and src/tokens.css.
 * These are the only three places brand literals live; tokens.ts is canonical.
 */
module.exports = {
  colors: {
    bg: "#0a0a0b",
    "bg-alt": "#131316",
    surface: "#18181b",
    "surface-raised": "#232327",
    "surface-hover": "#2e2e33",
    text: "#fafafa",
    accent: "#F95F4A",
    "accent-secondary": "#FF007A",
    speaking: "#F95F4A",
    danger: "#ea4335",
    warning: "#fbbf24",
    success: "#22c55e",
  },
  borderRadius: {
    tile: "16px",
    pill: "999px",
  },
  fontFamily: {
    sans: ["PolySans-Regular", "sans-serif"],
    display: ["PolySans-BulkyWide"],
    "polysans-median": ["PolySans-Median"],
    "polysans-slim": ["PolySans-Slim"],
  },
};
