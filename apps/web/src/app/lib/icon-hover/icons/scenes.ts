import { whole, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Decorative scene icons (video-effects background picker) — gentle signs of life.
export const sceneIcons: IconRegistry = {
  // The chair cushion gives a little sit-squash.
  armchair: whole("squish", { dur: 0.55, box: "fill", origin: "50% 100%" }),
  // Desk lamp warms up.
  "lamp-desk": whole("glow", { dur: 1, iter: "infinite" }),
  // Leaf sways from its stem.
  leaf: whole("sway", { dur: 0.7, box: "view", origin: "4px 20px" }),
  // Flower blooms.
  "flower-2": whole("twinkle", { dur: 0.7 }),
  // Steam curls off the cup.
  coffee: parts(part([1, 2, 4], "steam", { dur: 1, iter: "infinite", stagger: [0, 0.2, 0.4] })),
  // The cherry bobs on top.
  "cake-slice": parts(part(4, "bob", { dur: 0.6, iter: 2 })),
  // A curious glance side to side.
  glasses: whole("look", { dur: 0.6 }),
  // Tip of the hat.
  "hat-glasses": whole("tip", { dur: 0.6, box: "fill", origin: "50% 20%" }),
  // Settle in.
  house: whole("bob", { dur: 0.6 }),
  // Office windows light up.
  "building-2": parts(part([1, 2], "blink-op", { dur: 0.9, iter: "infinite", stagger: [0, 0.35] })),
};
