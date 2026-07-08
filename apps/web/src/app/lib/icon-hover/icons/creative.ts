import { whole, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Effects, imagery, layout & visibility.
export const creativeIcons: IconRegistry = {
  // The star twinkles; the little sparks blink around it.
  sparkles: parts(
    part(1, "twinkle", { dur: 0.6 }),
    part([2, 3, 4], "blink-op", { dur: 0.6, stagger: [0.1, 0.2, 0.3] }),
  ),
  // Sparks fire off the wand tip in sequence.
  "wand-sparkles": parts(
    part([2, 3, 4, 5, 6, 7, 8], "twinkle", { dur: 0.6, stagger: [0, 0.06, 0.12, 0.18, 0.24, 0.3, 0.36] }),
  ),
  // Swatches light up one after another.
  palette: parts(part([2, 3, 4, 5], "blink-op", { dur: 0.6, stagger: [0, 0.1, 0.2, 0.3] })),
  // The two circles slide together, blending.
  blend: parts(
    part(1, "nudge-loop", { dur: 0.9, iter: "infinite", dx: "1.5px" }),
    part(2, "nudge-loop", { dur: 0.9, iter: "infinite", dx: "-1.5px" }),
  ),
  // Crop marks pull the frame open along the diagonal.
  crop: parts(
    part(1, "nudge", { dur: 0.5, dx: "-1.5px", dy: "-1.5px" }),
    part(2, "nudge", { dur: 0.5, dx: "1.5px", dy: "1.5px" }),
  ),
  // The sun in the picture pulses.
  image: parts(part(2, "pulse", { dur: 0.9, iter: "infinite" })),
  "image-plus": parts(part([1, 2], "pop", { dur: 0.5 })),
  // The front photo shuffles.
  images: parts(part(4, "nudge", { dur: 0.5, dx: "1.5px", dy: "-1.5px" })),
  // Layers fan apart.
  layers: parts(
    part(1, "nudge", { dur: 0.5, dy: "-1.5px" }),
    part(3, "nudge", { dur: 0.5, dy: "1.5px" }),
  ),
  // Eyes blink.
  eye: whole("blink", { dur: 0.55 }),
  "eye-off": parts(part([1, 2, 3], "blink", { dur: 0.55 })),
  // No signal: the arcs search, then give up.
  "wifi-off": parts(part([1, 2, 3, 4, 5, 6], "blink-op", { dur: 0.7, stagger: [0, 0.08, 0.16, 0.16, 0.24, 0.24] })),
  zap: whole("flicker", { dur: 0.5 }),
  lightbulb: whole("glow", { dur: 0.9, iter: "infinite" }),
  "grid-3x3": whole("bob", { dur: 0.55 }),
  // Tiles light up, one corner at a time.
  "layout-grid": parts(part("all", "pop", { dur: 0.5, origin: "50% 50%", stagger: [0, 0.08, 0.16, 0.24] })),
  square: whole("bob", { dur: 0.55 }),
  // The leaning book rocks.
  "library-big": parts(part(3, "sway", { dur: 0.6, box: "view", origin: "16px 20px" })),
  // The envelope flap opens.
  mail: parts(part(1, "flap-open", { dur: 0.55, box: "view", origin: "12px 7px" })),
  // The lens sweeps as it searches.
  search: parts(part(2, "search-scan", { dur: 0.6 })),
};
