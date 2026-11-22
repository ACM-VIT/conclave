import { Logger } from "../utilities/loggers.js";

/** Runs a tick on an interval; nothing the tick throws or rejects can reach the process crash guards. */
export const startBackgroundTimer = (
  label: string,
  intervalMs: number,
  tick: () => unknown,
  log: (message: string, error: unknown) => void = Logger.warn,
): NodeJS.Timeout => {
  const timer = setInterval(() => {
    try {
      void Promise.resolve(tick()).catch((error: unknown) => {
        log(`${label} failed`, error);
      });
    } catch (error) {
      log(`${label} failed`, error);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
};
