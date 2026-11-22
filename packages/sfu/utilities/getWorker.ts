import type { Worker } from "mediasoup/types";

export type WorkerLoad = {
  consumers: number;
  rooms: number;
  pendingRooms: number;
};

const idle: WorkerLoad = { consumers: 0, rooms: 0, pendingRooms: 0 };

const getWorker = (
  workers: Worker[],
  loads: ReadonlyMap<number, WorkerLoad>,
): Worker => {
  let leastLoadedWorker: Worker | undefined;
  let leastScore = Infinity;
  let fewestRooms = Infinity;
  for (const worker of workers) {
    if (worker.closed) continue;
    const load = loads.get(worker.pid) ?? idle;
    const score = load.consumers + load.pendingRooms;
    const rooms = load.rooms + load.pendingRooms;
    if (
      score < leastScore ||
      (score === leastScore && rooms < fewestRooms)
    ) {
      leastLoadedWorker = worker;
      leastScore = score;
      fewestRooms = rooms;
    }
  }

  if (!leastLoadedWorker) throw new Error("No workers available");
  return leastLoadedWorker;
};

export default getWorker;
