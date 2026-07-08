/**
 * Reactive icon hover animations.
 *
 * A data-driven system that makes every lucide icon in the app react to hover
 * in a way that suits the glyph. The registry lives in ./icons (one module per
 * domain); ./keyframes holds the shared motion vocabulary; ./buildCss compiles
 * it to a stylesheet that <IconHoverStyles> injects once from the root layout.
 *
 * To tune an icon: edit its entry in the relevant ./icons module.
 * To add a motion: add a keyframe in ./keyframes and reference it by name.
 */
export { iconHoverCss } from "./buildCss";
export { ICONS } from "./registry";
export { KEYFRAMES } from "./keyframes";
export * from "./types";
