import { whole, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Locks, pins, links & tags.
export const securityIcons: IconRegistry = {
  // The shackle clicks down as it locks.
  lock: parts(part(2, "latch", { dur: 0.5, box: "view", origin: "12px 9px" })),
  // The shackle swings open on its hinge.
  "lock-open": parts(part(2, "unlatch", { dur: 0.55, box: "view", origin: "16px 7px" })),
  // Pin drops into place.
  pin: whole("drop", { dur: 0.5, box: "fill", origin: "50% 100%" }),
  "pin-off": whole("wiggle", { dur: 0.5, box: "fill", origin: "50% 90%" }),
  // The two link halves tug together and apart.
  "link-2": parts(
    part(1, "nudge-loop", { dur: 0.8, iter: "infinite", dx: "1.5px" }),
    part(2, "nudge-loop", { dur: 0.8, iter: "infinite", dx: "-1.5px" }),
  ),
  // The tag swings from its eyelet.
  tag: whole("swing", { dur: 0.7, box: "view", origin: "7px 7px" }),
  // Mysterious sway.
  "venetian-mask": whole("sway", { dur: 0.6 }),
};
