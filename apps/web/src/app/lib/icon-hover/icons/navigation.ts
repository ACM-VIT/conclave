import { whole, hold, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Directional & window controls, plus refresh/loaders/settings.
export const navigationIcons: IconRegistry = {
  // arrows & chevrons nudge in their own direction (translate the whole glyph)
  "arrow-left": parts(part("all", "nudge", { dur: 0.4, dx: "-3px" })),
  "arrow-right": parts(part("all", "nudge", { dur: 0.4, dx: "3px" })),
  "arrow-down": parts(part("all", "nudge", { dur: 0.4, dy: "3px" })),
  "chevron-left": parts(part("all", "nudge", { dur: 0.4, dx: "-3px" })),
  "chevron-right": parts(part("all", "nudge", { dur: 0.4, dx: "3px" })),
  "chevron-up": parts(part("all", "nudge", { dur: 0.4, dy: "-3px" })),
  "chevron-down": parts(part("all", "nudge", { dur: 0.4, dy: "3px" })),

  // Move: each of the four arrowheads pushes out in its own direction.
  move: parts(
    part(6, "nudge", { dur: 0.5, dy: "-2.5px" }), // up
    part(2, "nudge", { dur: 0.5, dy: "2.5px" }), // down
    part(3, "nudge", { dur: 0.5, dx: "2.5px" }), // right
    part(5, "nudge", { dur: 0.5, dx: "-2.5px" }), // left
  ),

  // The arrow flies out; the frame stays put.
  "external-link": parts(part([1, 2], "nudge", { dur: 0.45, dx: "2.5px", dy: "-2.5px" })),
  "log-out": parts(part([1, 2], "nudge", { dur: 0.45, dx: "3px" })),
  download: parts(part([1, 3], "nudge", { dur: 0.45, dy: "3px" })),
  // smoothly grow / shrink and hold, rather than a bouncy zoom
  "maximize-2": hold("scale(1.14)", { dur: 0.24 }),
  "minimize-2": hold("scale(0.86)", { dur: 0.24 }),
  "panel-right": parts(part(2, "nudge", { dur: 0.4, dx: "-2px" })),

  // refresh / rotate / loaders / gear
  "refresh-cw": whole("spin", { dur: 0.6, ease: "ease" }),
  "rotate-cw": whole("spin", { dur: 0.6, ease: "ease" }),
  "rotate-ccw": whole("spin-ccw", { dur: 0.6, ease: "ease" }),
  "loader-circle": whole("spin", { dur: 0.7, iter: "infinite", ease: "linear" }),
  settings: whole("spin", { dur: 0.8 }),
};
