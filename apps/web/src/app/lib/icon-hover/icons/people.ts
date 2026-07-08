import { whole, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// People & roles.
export const peopleIcons: IconRegistry = {
  "user-round": whole("bob", { dur: 0.6, iter: 2 }),
  users: whole("bob", { dur: 0.6, iter: 2 }),
  "user-check": parts(part(1, "check-in", { dur: 0.5 })), // the check ticks
  "user-plus": parts(part([3, 4], "pop", { dur: 0.5 })), // the +
  "user-x": parts(part([3, 4], "shake", { dur: 0.45 })), // the ×
  // A little regal rock, pivoting from the base.
  crown: whole("bob-tilt", { dur: 0.6, box: "fill", origin: "50% 100%" }),
};
