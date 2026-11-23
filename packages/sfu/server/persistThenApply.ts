import { readSfuEnv } from "../config/env.js";
import { Logger } from "../utilities/loggers.js";

/** A store write failed, so the change was not saved and memory was left as it was. */
export class PersistenceUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`Could not save ${what}`, { cause });
    this.name = "PersistenceUnavailableError";
  }
}

const queues = new WeakMap<object, Promise<unknown>>();

/** Runs work for one store one at a time, in the order it was asked for. */
export const serialized = <T>(store: object, work: () => T | Promise<T>): Promise<T> => {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(work, work);
  queues.set(store, run.catch(() => undefined));
  return run;
};

/**
 * Plans a change on a draft without touching memory, saves the plan, and only
 * then applies it to memory and its indexes. A failed save changes nothing,
 * so nothing has to be undone. Changes to one store run one at a time, so a
 * plan always sees every change committed before it, and a code or slug that
 * a pending delete or rename frees stays taken until that save succeeds.
 */
export const persistThenApply = <Plan>(
  store: object,
  what: string,
  steps: {
    plan: () => Plan | Promise<Plan>;
    save: (plan: Plan) => unknown;
    apply: (plan: Plan) => void;
  },
): Promise<Plan> =>
  serialized(store, async () => {
    const plan = await steps.plan();
    try {
      await steps.save(plan);
    } catch (error) {
      Logger.error(`Failed to save ${what}`, error);
      throw new PersistenceUnavailableError(what, error);
    }
    steps.apply(plan);
    return plan;
  });

/** The records a change may touch, named up front or picked from the store when the change runs. */
export type ChangeTargets<Store> = string[] | ((store: Store) => string[]);

export const targetIds = <Store>(targets: ChangeTargets<Store>, store: Store): string[] =>
  typeof targets === "function" ? targets(store) : targets;

/** Makes `target` equal to `next` while keeping the object other code holds. */
export const assignInPlace = <T extends object>(target: T, next: T): T => {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete (target as Record<string, unknown>)[key];
  }
  return Object.assign(target, next);
};

/** Whether two records would be stored the same way. */
export const sameStoredValue = (before: unknown, after: unknown): boolean =>
  before === after || JSON.stringify(before) === JSON.stringify(after);

/** The current values of `keys`, copied, to compare against when a later reply comes back. */
export const basisOf = <T extends object, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  structuredClone(Object.fromEntries(keys.map((key) => [key, record[key]]))) as Pick<T, K>;

/**
 * Applies the result of an outside call that came back later only if the
 * record still holds the values the result depends on, and nothing else.
 * Otherwise the result is dropped and logged, so a late reply never
 * overwrites newer state. Use it only for results that are safe to lose,
 * like a cached token: a side effect that already happened, like a created
 * calendar event, is reconciled instead of dropped.
 */
export const applyIfUnchanged = <T extends object, R>(
  what: string,
  record: T | undefined,
  basis: Partial<T>,
  apply: (record: T) => R,
): R | null => {
  const current =
    record !== undefined &&
    Object.entries(basis).every(([key, value]) => sameStoredValue(record[key as keyof T], value));
  if (!current) {
    Logger.info(`Dropped a late ${what}: the record changed while the call was in flight`);
    return null;
  }
  return apply(record);
};

const hasId = (value: unknown): value is { id: string } =>
  Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";

/**
 * Swaps the draft records in a change's result for the records memory now
 * holds: the result itself, the entries of an array result, or the fields of
 * an object result.
 */
export const committedRecords = <R>(byId: ReadonlyMap<string, object>, result: R): R => {
  const committed = (value: unknown): unknown => (hasId(value) ? byId.get(value.id) ?? value : value);
  if (Array.isArray(result)) return result.map(committed) as R;
  if (hasId(result) || !result || typeof result !== "object") return committed(result) as R;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, committed(value)])) as R;
};

/** Retries an idempotent step in the background with backoff, logging each failure; it never rejects. */
export const retryInBackground = (what: string, attempt: () => Promise<unknown>): void => {
  const delays = readSfuEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS");
  const tryAt = (index: number): void => {
    const timer = setTimeout(() => {
      attempt().catch((error: unknown) => {
        if (index + 1 < delays.length) {
          Logger.warn(`Retry ${index + 1} of ${what} failed; trying again`, error);
          tryAt(index + 1);
        } else {
          Logger.error(`Gave up on ${what} after ${delays.length} retries`, error);
        }
      });
    }, delays[index]);
    timer.unref?.();
  };
  tryAt(0);
};
