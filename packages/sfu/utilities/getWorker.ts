import type { Worker } from "mediasoup/types";

type WorkerLoadOptions = {
  loadScoresByPid?: Map<number, number>;
};

const getWorker = async (
  workers: Worker[],
  options: WorkerLoadOptions = {},
): Promise<Worker> => {
  // Only consider live workers. A worker that just died and is mid-replacement
  // must not receive a new router.
  const liveWorkers = workers.filter((worker) => !worker.closed);
  if (liveWorkers.length === 0) {
    throw new Error("No workers available");
  }

  let leastLoadedWorker = liveWorkers[0];
  let leastWorkerLoad =
    typeof leastLoadedWorker.pid === "number"
      ? options.loadScoresByPid?.get(leastLoadedWorker.pid) ?? 0
      : 0;

  for (const worker of liveWorkers.slice(1)) {
    const workerLoad =
      typeof worker.pid === "number"
        ? options.loadScoresByPid?.get(worker.pid) ?? 0
        : 0;
    if (workerLoad < leastWorkerLoad) {
      leastLoadedWorker = worker;
      leastWorkerLoad = workerLoad;
    }
  }

  return leastLoadedWorker;
};

export default getWorker;
