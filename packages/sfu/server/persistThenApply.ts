import { readSfuEnv } from "../config/env.js";
import { Logger } from "../utilities/loggers.js";

export class PersistenceUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`Could not save ${what}`, { cause });
    this.name = "PersistenceUnavailableError";
  }
}

export class ChangedElsewhereError extends Error {
  constructor(what: string) {
    super(`The ${what} changed somewhere else before this change was saved`);
    this.name = "ChangedElsewhereError";
  }
}

declare const committedBrand: unique symbol;

export type Committed<T> = T & { readonly [committedBrand]: true };

export const committed = <T>(value: T): Committed<T> => value as Committed<T>;

export const commitStamp = (at: number, held: number | null | undefined): number => Math.max(at, (held ?? 0) + 1);

const queues = new WeakMap<object, Promise<unknown>>();

export const serialized = <T>(store: object, work: () => T | Promise<T>): Promise<T> => {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(work, work);
  queues.set(store, run.catch(() => undefined));
  return run;
};

export const persistThenApply = <Plan, Result>(
  store: object,
  what: string,
  steps: {
    plan: (at: number) => Plan | Promise<Plan>;
    save: (plan: Plan) => Committed<Result> | Promise<Committed<Result>>;
    apply: (plan: Plan, result: Committed<Result>) => void;
  },
): Promise<Plan> =>
  serialized(store, async () => {
    const plan = await steps.plan(Date.now());
    let result: Committed<Result>;
    try {
      result = await steps.save(plan);
    } catch (error) {
      Logger.error(`Failed to save ${what}`, error);
      throw new PersistenceUnavailableError(what, error);
    }
    steps.apply(plan, result);
    return plan;
  });

export type ChangeTargets<Store> = string[] | ((store: Store, at: number) => string[]);

export const targetIds = <Store>(targets: ChangeTargets<Store>, store: Store, at: number): string[] =>
  typeof targets === "function" ? targets(store, at) : targets;

export const assignInPlace = <T extends object>(target: T, next: T): T => {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete (target as Record<string, unknown>)[key];
  }
  return Object.assign(target, next);
};

export const sameStoredValue = (before: unknown, after: unknown): boolean =>
  before === after || JSON.stringify(before) === JSON.stringify(after);

export const basisOf = <T extends object, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  structuredClone(Object.fromEntries(keys.map((key) => [key, record[key]]))) as Pick<T, K>;

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

export const committedRecords = <R>(byId: ReadonlyMap<string, object>, result: R): R => {
  const committed = (value: unknown): unknown => (hasId(value) ? byId.get(value.id) ?? value : value);
  if (Array.isArray(result)) return result.map(committed) as R;
  if (hasId(result) || !result || typeof result !== "object") return committed(result) as R;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, committed(value)])) as R;
};

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
