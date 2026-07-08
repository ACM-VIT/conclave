import { whole, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Games, creatures & science.
export const funIcons: IconRegistry = {
  // Face buttons press in, in sequence.
  "gamepad-2": parts(part([3, 4], "press", { dur: 0.4, origin: "50% 50%", stagger: [0, 0.1] })),
  // Bunny hop.
  rabbit: whole("hop", { dur: 0.55 }),
  // Rattling skull: the jaw shakes while the eye sockets blink.
  skull: merge(whole("shake", { dur: 0.5 }), parts(part([3, 4], "blink", { dur: 0.5 }))),
  // Blast off, with a little wobble.
  rocket: whole("launch", { dur: 0.6 }),
  // Take off diagonally.
  plane: whole("fly", { dur: 0.55 }),
  // Antenna twitches; robot eyes blink.
  bot: merge(
    parts(part(1, "wiggle", { dur: 0.6, box: "view", origin: "10px 8px" })),
    parts(part([5, 6], "blink", { dur: 0.6, delay: 0.15 })),
  ),
  // Thinking: the two hemispheres pulse back and forth.
  brain: parts(
    part([3, 4, 5, 6], "pulse", { dur: 0.9, iter: "infinite" }),
    part([2, 7, 8], "pulse", { dur: 0.9, iter: "infinite", delay: 0.45 }),
  ),
  // Blades snip around the pivot.
  scissors: parts(
    part([1, 2], "snip-a", { dur: 0.5, box: "view", origin: "9px 12px" }),
    part([4, 5], "snip-b", { dur: 0.5, box: "view", origin: "9px 12px" }),
  ),
  // The flask swirls; the liquid sloshes.
  "flask-conical": merge(whole("sway", { dur: 0.6 }), parts(part(2, "look", { dur: 0.6 }))),
};
