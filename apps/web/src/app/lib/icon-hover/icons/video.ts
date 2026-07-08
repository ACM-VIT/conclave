import { whole, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Video, screen-share & camera icons.
export const videoIcons: IconRegistry = {
  // The lens/viewfinder triangle "records" with a pulsing glow.
  video: parts(part(1, "record", { dur: 1, iter: "infinite" })),
  // Camera off: buzz + the strike-through flashes.
  "video-off": merge(whole("shake", { dur: 0.45 }), parts(part(3, "flash", { dur: 0.5 }))),
  // The lens ring focuses in and out.
  camera: parts(part(2, "pulse", { dur: 0.9, iter: "infinite" })),
  // Screen glows as if powering a signal.
  monitor: parts(part(1, "blink-op", { dur: 1.2, iter: "infinite" })),
  // Play triangle on the screen leans into motion.
  "monitor-play": parts(part(1, "nudge", { dur: 0.4, dx: "1.5px" })),
  // Presenting: the up-arrow lifts off the screen.
  "monitor-up": parts(part([1, 2], "nudge", { dur: 0.45, dy: "-2.5px" })),
  // The inset window slides into its corner.
  "picture-in-picture-2": parts(part(2, "nudge", { dur: 0.45, dx: "1.5px", dy: "1.5px" })),
  // Flip to the other camera.
  "switch-camera": whole("flip", { dur: 0.55 }),
  "flip-horizontal-2": whole("flip", { dur: 0.55 }),
  // Framing corners breathe inward.
  scan: whole("scan", { dur: 0.6 }),
  // Face unlock: eyes blink, then the mouth curves into a grin.
  "scan-face": merge(
    parts(part([6, 7], "blink", { dur: 0.6 })),
    parts(part(5, "nudge", { dur: 0.6, dy: "1px", delay: 0.1 })),
  ),
  // Focal point pulses.
  focus: parts(part(1, "pulse", { dur: 0.8, iter: "infinite" })),
};
