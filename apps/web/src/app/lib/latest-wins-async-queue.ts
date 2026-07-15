export type LatestWinsAsyncQueue<T> = {
  request: (value: T) => Promise<void>;
  clearPending: () => void;
};

/**
 * Serializes asynchronous mutations while retaining only the newest target
 * requested during an in-flight mutation.
 */
export const createLatestWinsAsyncQueue = <T,>(
  apply: (value: T) => Promise<void>,
  onError?: (error: unknown) => void,
): LatestWinsAsyncQueue<T> => {
  let currentValue: T | undefined;
  let hasCurrentValue = false;
  let pendingValue: T | undefined;
  let hasPendingValue = false;
  let drainPromise: Promise<void> | null = null;

  const drain = async () => {
    while (hasPendingValue) {
      currentValue = pendingValue;
      hasCurrentValue = true;
      hasPendingValue = false;
      try {
        await apply(currentValue as T);
      } catch (error) {
        onError?.(error);
      }
    }
    currentValue = undefined;
    hasCurrentValue = false;
  };

  return {
    request(value) {
      if (
        drainPromise !== null &&
        hasCurrentValue &&
        Object.is(value, currentValue)
      ) {
        pendingValue = undefined;
        hasPendingValue = false;
        return drainPromise;
      }

      pendingValue = value;
      hasPendingValue = true;
      if (drainPromise === null) {
        drainPromise = Promise.resolve()
          .then(drain)
          .finally(() => {
            drainPromise = null;
          });
      }
      return drainPromise;
    },
    clearPending() {
      pendingValue = undefined;
      hasPendingValue = false;
    },
  };
};
