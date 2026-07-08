import { whole, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Chat & messaging.
export const chatIcons: IconRegistry = {
  // Bubble gives a soft nudge, like it just arrived.
  "message-square": whole("bob", { dur: 0.55 }),
  // Lines of text type themselves in from the left.
  "message-square-text": parts(
    part([2, 3, 4], "type-line", { dur: 0.5, origin: "0% 50%", stagger: [0, 0.1, 0.2] }),
  ),
  // The shackle jiggles on its lock.
  "message-square-lock": parts(part(2, "wiggle", { dur: 0.5, box: "view", origin: "18px 13px" })),
  // Second bubble bobs forward.
  "messages-square": whole("bob", { dur: 0.55 }),
  // Paper plane whooshes off and springs back.
  send: parts(part("all", "whoosh", { dur: 0.6 })),
  // Reply arrow curls back to the left.
  reply: parts(part(2, "nudge", { dur: 0.45, dx: "-3px" })),
  // A happy little head-tilt while the grin deepens (the mouth curves lower).
  smile: merge(whole("sway", { dur: 0.6 }), parts(part(2, "nudge", { dur: 0.55, dy: "1px" }))),
};
