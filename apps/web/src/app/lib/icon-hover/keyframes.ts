import type { KeyframeMap } from "./types";

/**
 * Shared motion vocabulary. Each value is the body between the `{ }` of
 * `@keyframes ai-<name>`. Icon modules reference these by name.
 *
 * Conventions:
 *  - One-shot motions (pop, nudge, tick…) start and END at rest, so they read
 *    as a reaction to hover and then settle.
 *  - Looping motions (eq, flow, glow, steam, blink-op…) are seamless
 *    (start == end) and marked `iter: 'infinite'` at the call site.
 */
export const KEYFRAMES: KeyframeMap = {
  // rotation
  spin: "to { transform: rotate(360deg); }",
  "spin-ccw": "to { transform: rotate(-360deg); }",

  // scale / emphasis
  pulse: "50% { transform: scale(1.16); }",
  // Restrained double-thump for status dots — no big rubbery overshoot.
  beat: "0%, 100% { transform: scale(1); } 28% { transform: scale(1.18); } 52% { transform: scale(0.98); } 76% { transform: scale(1.06); }",
  // A crisp confirm: a light single overshoot that settles, not a bouncy zoom.
  pop: "40% { transform: scale(1.12); } 72% { transform: scale(0.985); } 100% { transform: scale(1); }",
  // Button press-in.
  press: "45% { transform: scale(0.86); } 100% { transform: scale(1); }",
  // A checkmark "ticking" — slides along its own stroke and settles (no scale).
  "check-in": "0% { transform: translate(-1.6px, 1px); } 55% { transform: translate(0.6px, -0.5px); } 100% { transform: translate(0, 0); }",
  flash: "0%, 100% { opacity: 1; transform: scale(1); } 30% { opacity: 0.2; transform: scale(1.16); } 60% { opacity: 1; }",
  record: "0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.16); opacity: 0.55; }",

  // vertical / bob
  bob: "50% { transform: translateY(-2.5px); }",
  "bob-tilt": "50% { transform: translateY(-2.5px) rotate(-7deg); }",
  hop: "30% { transform: translateY(-4px) scaleY(1.06); } 55% { transform: translateY(0) scaleY(0.9); } 78% { transform: translateY(-1.5px); } 100% { transform: translateY(0); }",
  drop: "0% { transform: translateY(-3.5px); } 55% { transform: translateY(1px); } 78% { transform: translateY(-0.5px); } 100% { transform: translateY(0); }",
  squish: "45% { transform: scaleY(0.86) translateY(1px); } 100% { transform: scaleY(1); }",

  // rotation-based character motions
  wiggle: "25% { transform: rotate(-12deg); } 50% { transform: rotate(9deg); } 75% { transform: rotate(-5deg); } 100% { transform: rotate(0); }",
  swing: "20% { transform: rotate(16deg); } 45% { transform: rotate(-11deg); } 70% { transform: rotate(6deg); } 100% { transform: rotate(0); }",
  sway: "25% { transform: rotate(9deg); } 60% { transform: rotate(-7deg); } 100% { transform: rotate(0); }",
  tip: "30% { transform: rotate(-11deg); } 70% { transform: rotate(3deg); } 100% { transform: rotate(0); }",
  peel: "40% { transform: rotate(-13deg); } 100% { transform: rotate(0); }",
  "wave-hand": "15% { transform: rotate(15deg); } 30% { transform: rotate(-9deg); } 45% { transform: rotate(13deg); } 60% { transform: rotate(-7deg); } 80% { transform: rotate(4deg); } 100% { transform: rotate(0); }",
  tick: "30% { transform: rotate(26deg); } 62% { transform: rotate(-9deg); } 100% { transform: rotate(0); }",

  // shake / translate
  shake: "15% { transform: translateX(-2px); } 30% { transform: translateX(2px); } 45% { transform: translateX(-1.6px); } 60% { transform: translateX(1.6px); } 80% { transform: translateX(-0.8px); } 100% { transform: translateX(0); }",
  look: "25% { transform: translateX(-1.6px); } 60% { transform: translateX(1.6px); } 100% { transform: translateX(0); }",
  nudge: "50% { transform: translate(var(--ai-dx, 0), var(--ai-dy, 0)); }",
  "nudge-loop": "0%, 100% { transform: translate(0, 0); } 50% { transform: translate(var(--ai-dx, 0), var(--ai-dy, 0)); }",

  // sparkle / light
  twinkle: "30% { transform: scale(1.2) rotate(20deg); } 60% { transform: scale(0.85) rotate(-14deg); } 100% { transform: scale(1) rotate(0); }",
  flicker: "10% { opacity: 0.3; transform: scale(1.14); } 20% { opacity: 1; } 32% { opacity: 0.45; transform: scale(0.93); } 46% { opacity: 1; } 60%, 100% { transform: scale(1); }",
  glow: "50% { opacity: 0.5; transform: scale(1.14); }",
  "blink-op": "0%, 100% { opacity: 1; } 50% { opacity: 0.2; }",
  blink: "45%, 55% { transform: scaleY(0.1); }",

  // flight
  fly: "35% { transform: translate(3px, -3px) rotate(10deg); } 100% { transform: translate(0, 0) rotate(0); }",
  whoosh: "38% { transform: translate(5px, -5px) scale(0.85); opacity: 0.35; } 60% { transform: translate(-1px, 1px); opacity: 1; } 100% { transform: translate(0, 0) scale(1); }",
  launch: "18% { transform: translate(1px, 1px) rotate(-3deg); } 55% { transform: translate(-2px, -5px) rotate(-11deg); } 78% { transform: translate(0.5px, -1px) rotate(3deg); } 100% { transform: translate(0, 0) rotate(0); }",

  // audio / waves
  "eq-a": "0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); }",
  "eq-b": "0%, 100% { transform: scaleY(0.62); } 50% { transform: scaleY(1); }",
  flow: "50% { transform: translateX(2.5px); }",
  swell: "50% { transform: translate(2px, -1px); }",
  emanate: "0% { opacity: 0.35; transform: scale(0.88); } 50% { opacity: 1; transform: scale(1.06); } 100% { opacity: 0.35; transform: scale(0.88); }",

  // misc mechanical
  steam: "0% { opacity: 0.25; transform: translateY(1px); } 50% { opacity: 1; transform: translateY(-1.5px); } 100% { opacity: 0.25; transform: translateY(1px); }",
  "type-line": "0% { transform: scaleX(0.15); opacity: 0.4; } 60% { transform: scaleX(1); opacity: 1; } 100% { transform: scaleX(1); }",
  "lid-lift": "30% { transform: rotate(-16deg) translateY(-1px); } 60% { transform: rotate(6deg); } 100% { transform: rotate(0); }",
  "flap-open": "40% { transform: scaleY(-0.4); } 100% { transform: scaleY(1); }",
  latch: "40% { transform: translateY(2px); } 70% { transform: translateY(-0.5px); } 100% { transform: translateY(0); }",
  unlatch: "40% { transform: rotate(-30deg); } 75% { transform: rotate(4deg); } 100% { transform: rotate(0); }",
  "snip-a": "35% { transform: rotate(11deg); } 70% { transform: rotate(2deg); } 100% { transform: rotate(0); }",
  "snip-b": "35% { transform: rotate(-11deg); } 70% { transform: rotate(-2deg); } 100% { transform: rotate(0); }",
  scan: "35% { transform: scale(0.86); } 70% { transform: scale(1.08); } 100% { transform: scale(1); }",
  "pen-write": "20% { transform: translate(1.6px, -1px); } 40% { transform: translate(-1px, 0.6px); } 60% { transform: translate(1.6px, -1px); } 80% { transform: translate(-1px, 0.6px); } 100% { transform: translate(0, 0); }",
  flip: "50% { transform: scaleX(-1); }",
  "search-scan": "25% { transform: translate(1.6px, -1.6px); } 50% { transform: translate(2px, 1px); } 75% { transform: translate(-1px, 1.6px); } 100% { transform: translate(0, 0); }",
};
