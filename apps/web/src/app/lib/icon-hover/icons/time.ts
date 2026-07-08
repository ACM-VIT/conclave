import { part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Clocks & calendars. Clock hands tick around the dial centre (view-box coords).
export const timeIcons: IconRegistry = {
  clock: parts(part(1, "tick", { dur: 0.6, box: "view", origin: "12px 12px" })),
  "clock-3": parts(part(1, "tick", { dur: 0.6, box: "view", origin: "12px 12px" })),
  "calendar-clock": parts(part(1, "tick", { dur: 0.6, box: "view", origin: "16px 16px" })),
  "calendar-check": parts(part(5, "check-in", { dur: 0.5 })), // the check ticks
  "calendar-plus": parts(part([1, 3], "pop", { dur: 0.5 })), // the +
};
