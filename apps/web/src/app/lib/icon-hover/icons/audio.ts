import { whole, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Audio & microphone icons.
export const audioIcons: IconRegistry = {
  // Equalizer: alternating bars use two amplitude ranges + offset phases so the
  // waveform ripples instead of pulsing in unison. Parts are the 6 vertical bars.
  "audio-lines": parts(
    part([2, 4, 6], "eq-b", { dur: 0.9, iter: "infinite", origin: "50% 50%", stagger: [0.12, 0.06, 0.3] }),
    part([1, 3, 5], "eq-a", { dur: 0.9, iter: "infinite", origin: "50% 50%", stagger: [0, 0.24, 0.18] }),
  ),
  // Three swell lines drift diagonally at offset phases, like a passing swell.
  waves: parts(part("all", "swell", { dur: 1.1, iter: "infinite", stagger: [0, 0.18, 0.36] })),
  // Sound rings emanate outward; the cone gives a tiny sympathetic pulse.
  "volume-2": merge(
    parts(part([2, 3], "emanate", { dur: 0.9, iter: "infinite", origin: "left center", stagger: [0, 0.2] })),
    parts(part(1, "pulse", { dur: 0.9, iter: "infinite", origin: "left center" })),
  ),
  // Muted: the X flashes for emphasis over a firm buzz.
  "volume-x": merge(whole("shake", { dur: 0.45 }), parts(part([2, 3], "flash", { dur: 0.5 }))),
  // Live mic: the capsule "listens" with a steady pulse.
  mic: parts(part(3, "pulse", { dur: 0.8, iter: "infinite" })),
  // Muted mic buzzes while the strike-through flashes.
  "mic-off": merge(whole("shake", { dur: 0.45 }), parts(part(5, "flash", { dur: 0.5 }))),
};
