import { whole, part, parts } from "../builders";
import type { IconRegistry } from "../types";

// Files, editing, lists & the terminal.
export const docsIcons: IconRegistry = {
  // The pencil scribbles a short stroke.
  pencil: whole("pen-write", { dur: 0.55 }),
  // Pencil-line: only the pencil writes; the underline holds.
  "pencil-line": parts(part(3, "pen-write", { dur: 0.55 })),
  // Body text types itself in, line by line, from the left.
  "file-text": parts(part([3, 4, 5], "type-line", { dur: 0.5, origin: "0% 50%", stagger: [0, 0.1, 0.2] })),
  // The folded corner peels up.
  "sticky-note": parts(part(2, "peel", { dur: 0.55, box: "view", origin: "18px 3px" })),
  // The copied page slides out.
  "clipboard-copy": parts(part(5, "nudge", { dur: 0.45, dx: "-2.5px" })),
  // The front sheet lifts off the back one.
  copy: parts(part(1, "nudge", { dur: 0.45, dx: "1.5px", dy: "-1.5px" })),
  // Checklist ticks draw themselves in, bottom-up.
  "list-checks": parts(part([4, 5], "check-in", { dur: 0.5, stagger: [0.1, 0] })),
  "list-todo": parts(part(4, "check-in", { dur: 0.5 })),
  "list-tree": whole("bob", { dur: 0.6 }),
  // Terminal cursor blinks.
  "square-terminal": parts(part(2, "blink-op", { dur: 0.7, iter: "infinite" })),
  // Keys light up in a typing ripple (the 7 key glyphs, not the frame/spacebar).
  keyboard: parts(
    part([1, 8, 6, 2, 4, 3, 5], "blink-op", {
      dur: 0.6,
      iter: "infinite",
      stagger: [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48],
    }),
  ),
  // The lid + handle tilt open, hinged at the rim.
  "trash-2": parts(part([4, 5], "lid-lift", { dur: 0.55, box: "view", origin: "12px 6px" })),
};
