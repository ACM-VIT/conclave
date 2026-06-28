import type { GameConfig, GameOptionSpec } from "./types.js";

/** Build the all-defaults config for a set of option specs. */
export const defaultConfig = (options: GameOptionSpec[] = []): GameConfig => {
  const config: GameConfig = {};
  for (const opt of options) config[opt.id] = opt.default;
  return config;
};

/**
 * Validate a raw (untrusted) config from the client against the module's option
 * specs. Unknown keys are dropped; numbers are clamped to range and rounded;
 * selects must be a known choice. Anything invalid falls back to the default.
 */
export const normalizeConfig = (
  options: GameOptionSpec[] = [],
  raw: unknown,
): GameConfig => {
  const input =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const config: GameConfig = {};
  for (const opt of options) {
    const value = input[opt.id];
    if (opt.type === "number") {
      const num = typeof value === "number" && Number.isFinite(value) ? value : opt.default;
      config[opt.id] = Math.min(opt.max, Math.max(opt.min, Math.round(num)));
    } else {
      config[opt.id] =
        typeof value === "string" && opt.choices.some((c) => c.value === value)
          ? value
          : opt.default;
    }
  }
  return config;
};

/** Typed accessors for module setup code. */
export const numberOption = (config: GameConfig, id: string, fallback: number): number => {
  const value = config[id];
  return typeof value === "number" ? value : fallback;
};

export const selectOption = (config: GameConfig, id: string, fallback: string): string => {
  const value = config[id];
  return typeof value === "string" ? value : fallback;
};
