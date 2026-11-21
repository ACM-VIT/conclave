import type { Worker } from "mediasoup/types";

export type WorkerLoad = {
  consumers: number;
  rooms: number;
};

const idle: WorkerLoad = { consumers: 0, rooms: 0 };

const getWorker = (
  workers: Worker[],
  loads: ReadonlyMap<number, WorkerLoad>,
): Worker => {
  let leastLoadedWorker: Worker | undefined;
  let leastLoad = idle;
  for (const worker of workers) {
    if (worker.closed) continue;
    const load = loads.get(worker.pid) ?? idle;
    if (
      !leastLoadedWorker ||
      load.consumers < leastLoad.consumers ||
      (load.consumers === leastLoad.consumers && load.rooms < leastLoad.rooms)
    ) {
      leastLoadedWorker = worker;
      leastLoad = load;
    }
  }

  if (!leastLoadedWorker) throw new Error("No workers available");
  return leastLoadedWorker;
};

export default getWorker;
