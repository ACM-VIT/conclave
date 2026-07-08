import { whole, hold, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Confirmations, dismissals, alerts, info and media transport.
export const statusIcons: IconRegistry = {
  // confirm — the tick "draws" along its stroke
  check: whole("check-in", { dur: 0.5 }),
  "circle-check": parts(part(2, "check-in", { dur: 0.5 })),
  // dismiss — grows a touch and holds (smooth, not a bounce)
  x: hold("scale(1.14)", { dur: 0.22 }),
  "circle-x": parts(part([2, 3], "shake", { dur: 0.45 })),
  // add — grows a touch and holds (smooth, not a bounce)
  plus: hold("scale(1.16)", { dur: 0.22 }),
  minus: hold("scaleX(1.22)", { dur: 0.22 }),
  // status dot — a calm double-thump
  dot: whole("beat", { dur: 0.7 }),
  // Three dots bounce left→right (child order is mid, right, left).
  ellipsis: parts(part("all", "bob", { dur: 0.5, stagger: [0.14, 0, 0.07] })),
  "more-horizontal": parts(part("all", "bob", { dur: 0.5, stagger: [0.14, 0, 0.07] })),

  // alerts / info — the payload (the "!"/"?"/"i") reacts, the frame holds
  "circle-alert": parts(part([2, 3], "shake", { dur: 0.45 })),
  "triangle-alert": parts(part([2, 3], "shake", { dur: 0.45 })),
  info: parts(part([2, 3], "bob", { dur: 0.5, iter: 2 })),
  "circle-question-mark": parts(part([2, 3], "wiggle", { dur: 0.5 })),
  shield: whole("pulse", { dur: 0.7 }),
  "shield-ban": merge(whole("shake", { dur: 0.45 }), parts(part(2, "flash", { dur: 0.5 }))),

  // transport — the play triangle leans into motion; pause holds a gentle press
  play: parts(part(1, "nudge", { dur: 0.4, dx: "1.5px" })),
  "circle-play": parts(part(1, "nudge", { dur: 0.4, dx: "1.5px" })),
  pause: parts(part("all", "press", { dur: 0.4, origin: "50% 50%", stagger: [0, 0.08] })),
};
