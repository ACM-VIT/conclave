import { Logger } from "../utilities/loggers.js";

export const runDetached = (label: string, work: () => unknown): void => {
  const fail = (error: unknown) => Logger.error(`${label} failed`, error);
  try {
    const result = work();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(undefined, fail);
    }
  } catch (error) {
    fail(error);
  }
};
