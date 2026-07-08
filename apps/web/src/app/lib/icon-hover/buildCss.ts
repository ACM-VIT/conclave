import { KEYFRAMES } from "./keyframes";
import { ICONS } from "./registry";
import type { AnimSpec, PartSpec } from "./types";

/**
 * Compiles the icon registry into a single stylesheet string.
 *
 * Lucide renders `<svg class="lucide lucide-<slug>">` with parts as ordered
 * children, so every rule keys off `.lucide-<slug>` (and its `> *:nth-child`).
 * The trigger is a hover on the icon itself OR on the interactive control that
 * contains it. Everything is wrapped in `prefers-reduced-motion: no-preference`.
 *
 * The output is deterministic and only depends on the static registry, so it is
 * built once and cached at module scope (see `iconHoverCss`).
 */

const TRIGGERS =
  'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], summary, label, [data-icon-hover]';
const HOVER = `:is(${TRIGGERS}):hover`;

// A relaxed spring for held poses: eases out with a hint of overshoot so it
// settles rather than snapping — the opposite feel of a bouncy keyframe pop.
const HOLD_EASE = "cubic-bezier(0.34, 1.28, 0.64, 1)";

const usedKeyframes = new Set<string>();

/** transform-box / transform-origin lines shared by animation and hold rules. */
function boxOriginLines(spec: AnimSpec, indent: string): string[] {
  const lines: string[] = [];
  if (spec.box === "view") lines.push("transform-box: view-box;");
  else if (spec.box === "fill" || spec.origin) lines.push("transform-box: fill-box;");
  if (spec.origin) lines.push(`transform-origin: ${spec.origin};`);
  return lines.map((l) => indent + l);
}

function declarations(spec: AnimSpec, indent: string): string {
  if (!spec.kf) throw new Error("icon-hover: animation spec is missing `kf`");
  usedKeyframes.add(spec.kf);
  const lines = [
    `animation-name: ai-${spec.kf};`,
    `animation-duration: ${spec.dur ?? 0.5}s;`,
    `animation-timing-function: ${spec.ease ?? "ease-in-out"};`,
    `animation-iteration-count: ${spec.iter ?? 1};`,
  ];
  if (spec.delay != null) lines.push(`animation-delay: ${spec.delay}s;`);
  if (spec.dx != null) lines.push(`--ai-dx: ${spec.dx};`);
  if (spec.dy != null) lines.push(`--ai-dy: ${spec.dy};`);
  return [...lines.map((l) => indent + l), ...boxOriginLines(spec, indent)].join("\n");
}

function childSelectors(on: PartSpec["on"]): string[] {
  if (on === "all") return ["> *"];
  const list = Array.isArray(on) ? on : [on];
  return list.map((n) => `> *:nth-child(${n})`);
}

// hovered-state selector for the whole svg (interactive ancestor OR direct hover)
function svgHoverSel(slug: string): string {
  return `  ${HOVER} svg.lucide-${slug},\n  svg.lucide-${slug}:hover`;
}

// hovered-state selector for specific child parts
function partHoverSel(slug: string, on: PartSpec["on"]): string {
  const selectors: string[] = [];
  for (const k of childSelectors(on)) {
    selectors.push(`  ${HOVER} svg.lucide-${slug} ${k},`);
    selectors.push(`  svg.lucide-${slug}:hover ${k},`);
  }
  selectors[selectors.length - 1] = selectors[selectors.length - 1].replace(/,$/, "");
  return selectors.join("\n");
}

// base (always-on) selector for the whole svg — used to attach a hold transition
function svgBaseSel(slug: string): string {
  return `  svg.lucide-${slug}`;
}

// base (always-on) selector for specific child parts
function partBaseSel(slug: string, on: PartSpec["on"]): string {
  return childSelectors(on)
    .map((k) => `  svg.lucide-${slug} ${k}`)
    .join(",\n");
}

function svgRule(slug: string, spec: AnimSpec): string {
  if (spec.hold) return holdRule(svgBaseSel(slug), svgHoverSel(slug), spec);
  return `${svgHoverSel(slug)} {\n${declarations(spec, "    ")}\n  }`;
}

function partRule(slug: string, spec: PartSpec): string {
  if (spec.hold) return holdRule(partBaseSel(slug, spec.on), partHoverSel(slug, spec.on), spec);
  return `${partHoverSel(slug, spec.on)} {\n${declarations(spec, "    ")}\n  }`;
}

// A held pose: transition on the resting element, transform applied on hover.
function holdRule(baseSel: string, hoverSel: string, spec: AnimSpec): string {
  const dur = spec.dur ?? 0.24;
  const ease = spec.ease ?? HOLD_EASE;
  const base = [`    transition: transform ${dur}s ${ease};`, ...boxOriginLines(spec, "    ")].join("\n");
  return `${baseSel} {\n${base}\n  }\n\n${hoverSel} {\n    transform: ${spec.hold};\n  }`;
}

// Per-part stagger delays. These are inert until the gated part rule above turns
// the animation on, so they can be plain (un-triggered) selectors — and they must
// use the `animation-delay` longhand so a shorthand elsewhere can't reset them.
function staggerRule(slug: string, spec: PartSpec): string | null {
  if (!spec.stagger) return null;
  const ons = spec.on === "all" ? null : Array.isArray(spec.on) ? spec.on : [spec.on];
  return spec.stagger
    .map((d, i) => {
      const nth = spec.on === "all" ? i + 1 : ons![i];
      return `  svg.lucide-${slug} > *:nth-child(${nth}) { animation-delay: ${d}s; }`;
    })
    .join("\n");
}

function build(): string {
  usedKeyframes.clear();
  const rules: string[] = [];

  for (const [slug, def] of Object.entries(ICONS)) {
    if (def.svg) rules.push(svgRule(slug, def.svg));
    for (const partSpec of def.parts ?? []) {
      rules.push(partRule(slug, partSpec));
      const stagger = staggerRule(slug, partSpec);
      if (stagger) rules.push(stagger);
    }
  }

  const keyframeCss = Object.entries(KEYFRAMES)
    .filter(([name]) => usedKeyframes.has(name))
    .map(([name, body]) => `  @keyframes ai-${name} {\n    ${body}\n  }`)
    .join("\n");

  const count = Object.keys(ICONS).length;

  return `/*
 * Reactive icon hover animations — compiled from src/app/lib/icon-hover.
 * ${count} icons; each animates the parts that matter (trash lid lifts, coffee
 * steams, terminal cursor blinks, scissors snip, clock ticks, keys type…).
 * Gated behind prefers-reduced-motion; runs on hover of the icon or its
 * enclosing button / link / menu-item / tab / label.
 */
@media (prefers-reduced-motion: no-preference) {
  svg.lucide {
    transform-box: fill-box;
    transform-origin: 50% 50%;
  }

${keyframeCss}

${rules.join("\n\n")}
}`;
}

/** The compiled stylesheet. Static registry → build once, reuse. */
export const iconHoverCss: string = build();
