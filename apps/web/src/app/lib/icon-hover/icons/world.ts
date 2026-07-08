import { whole, part, parts, merge } from "../builders";
import type { IconRegistry } from "../types";

// Globe, world & weather.
export const worldIcons: IconRegistry = {
  globe: whole("spin", { dur: 1, ease: "ease-in-out" }),
  earth: whole("spin", { dur: 1, ease: "ease-in-out" }),
  snowflake: whole("spin", { dur: 1.2, ease: "ease-in-out" }),
  // Rays turn slowly while the core glows.
  "sun-medium": merge(
    whole("spin", { dur: 3, iter: "infinite", ease: "linear" }),
    parts(part(1, "glow", { dur: 1.2, iter: "infinite" })),
  ),
};
