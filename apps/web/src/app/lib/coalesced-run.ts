type Run<T> = () => Promise<T>;

/**
 * Runs one task at a time. Requests made while a run is in flight share a
 * single follow-up run of the latest task, so a burst costs at most two runs
 * and every caller still gets the result of a run that started after it
 * asked.
 */
export function createCoalescedRunner<T = void>(): (run: Run<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let queuedRun: Run<T> | null = null;
  let queuedDone: Promise<T> | null = null;

  const start = (run: Run<T>): Promise<T> => {
    const done = Promise.resolve()
      .then(run)
      .finally(() => {
        inFlight = null;
      });
    inFlight = done;
    return done;
  };

  return (run) => {
    if (queuedDone) {
      queuedRun = run;
      return queuedDone;
    }
    if (!inFlight) return start(run);
    queuedRun = run;
    const startQueued = (): Promise<T> => {
      const next = queuedRun ?? run;
      queuedRun = null;
      queuedDone = null;
      return start(next);
    };
    queuedDone = inFlight.then(startQueued, startQueued);
    return queuedDone;
  };
}
