type Run = () => Promise<void>;

/**
 * Runs one task at a time. Requests made while a run is in flight share a
 * single follow-up run of the latest task, so a burst costs at most two runs
 * and every caller still gets a run that started after it asked.
 */
export function createCoalescedRunner(): (run: Run) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queuedRun: Run | null = null;
  let queuedDone: Promise<void> | null = null;

  const start = (run: Run): Promise<void> => {
    const done = Promise.resolve()
      .then(run)
      .finally(() => {
        inFlight = null;
      });
    inFlight = done;
    return done;
  };

  const startQueued = (): Promise<void> => {
    const run = queuedRun;
    queuedRun = null;
    queuedDone = null;
    return run ? start(run) : Promise.resolve();
  };

  return (run) => {
    if (queuedDone) {
      queuedRun = run;
      return queuedDone;
    }
    if (!inFlight) return start(run);
    queuedRun = run;
    queuedDone = inFlight.then(startQueued, startQueued);
    return queuedDone;
  };
}
