import { Logger } from "../../utilities/loggers.js";
import type { CommitResult } from "./model.js";
import type { ControlPlaneStore } from "./store.js";
import type { Command } from "./tx.js";

const DEFAULT_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];

const retryDelays = (): number[] => {
  const configured = process.env.SFU_FOLLOW_UP_RETRY_DELAYS_MS?.trim();
  if (!configured) return DEFAULT_DELAYS_MS;
  const delays = configured
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  return delays.length > 0 ? delays : DEFAULT_DELAYS_MS;
};

type FollowUpOptions = { retryOnConflict?: boolean };

const isRetryableConflict = <T>(result: CommitResult<T>, options: FollowUpOptions): boolean =>
  options.retryOnConflict === true && !result.ok && result.reason === "conflict";

const retryLater = <T>(
  store: ControlPlaneStore,
  label: string,
  command: Command<T>,
  options: FollowUpOptions,
  delays: number[],
): void => {
  const [delay, ...rest] = delays;
  if (delay === undefined) {
    Logger.error(`[ControlPlane] gave up recording ${label}; it is not saved`);
    return;
  }
  const timer = setTimeout(() => {
    store.commit(command).then(
      (result) => {
        if (isRetryableConflict(result, options)) retryLater(store, label, command, options, rest);
        else if (!result.ok) Logger.warn(`[ControlPlane] ${label} no longer applies: ${result.reason}`);
      },
      (error: unknown) => {
        Logger.warn(`[ControlPlane] retrying ${label} after a storage error`, error);
        retryLater(store, label, command, options, rest);
      },
    );
  }, delay);
  timer.unref?.();
};

export const commitFollowUp = async <T>(
  store: ControlPlaneStore,
  label: string,
  command: Command<T>,
  options: FollowUpOptions = {},
): Promise<CommitResult<T> | null> => {
  try {
    const result = await store.commit(command);
    if (!isRetryableConflict(result, options)) return result;
    Logger.warn(`[ControlPlane] could not record ${label} yet after a write conflict`);
  } catch (error) {
    Logger.warn(`[ControlPlane] could not record ${label} yet`, error);
  }
  retryLater(store, label, command, options, retryDelays());
  return null;
};
