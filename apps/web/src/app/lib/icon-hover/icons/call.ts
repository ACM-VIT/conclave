import { whole } from "../builders";
import type { IconRegistry } from "../types";

// Call controls.
export const callIcons: IconRegistry = {
  // Hang up: a decisive buzz.
  "phone-off": whole("shake", { dur: 0.45 }),
  // Raise hand: waves from the wrist.
  hand: whole("wave-hand", { dur: 0.8, box: "fill", origin: "55% 95%" }),
};
