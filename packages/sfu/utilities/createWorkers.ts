import * as mediasoup from "mediasoup";
import type { Worker } from "mediasoup/types";
import os from "os";
import { config } from "../config/config.js";
import { Logger } from "./loggers.js";

const getAutoWorkerCount = (): number => {
  if (typeof os.availableParallelism === "function") {
    return os.availableParallelism();
  }
  return os.cpus().length;
};

const getWorkerCount = (): number =>
  Math.max(1, config.workerSettings.workerCount || getAutoWorkerCount());

type CreateWorkersOptions = {
  onWorkerDied?: (worker: Worker, label: string) => void | Promise<void>;
};

const spawnWorker = (): Promise<Worker> =>
  mediasoup.createWorker({
    rtcMinPort: config.workerSettings.rtcMinPort,
    rtcMaxPort: config.workerSettings.rtcMaxPort,
    logLevel: config.workerSettings.logLevel,
    logTags: config.workerSettings.logTags,
  });

const createWorkers = async (
  options: CreateWorkersOptions = {},
): Promise<Worker[]> => {
  const workers: Worker[] = [];

  // A dead mediasoup worker takes its routers - and the rooms running on them -
  // with it. Previously the handler did `process.exit(1)`, which killed the
  // WHOLE instance and every healthy room on the other workers too. Instead we
  // recreate a replacement worker IN PLACE so the pool stays full and new rooms
  // get allocated to a healthy worker. `workers` is the exact array stored on
  // `state.workers`, so mutating it here updates the live pool. Rooms that were
  // on the dead worker degrade (their producers/consumers error) and their
  // clients rejoin via the normal reconnect path, landing on a healthy worker.
  const attachDiedHandler = (worker: Worker, label: string): void => {
    worker.on("died", () => {
      Logger.error(`Worker ${label} has died; recreating a replacement`);
      void Promise.resolve(options.onWorkerDied?.(worker, label)).catch(
        (error) => {
          Logger.error(
            `Failed to clean up rooms for dead worker ${label}: ${String(error)}`,
          );
        },
      );
      const deadIndex = workers.indexOf(worker);
      spawnWorker()
        .then((replacement) => {
          if (deadIndex >= 0) {
            workers[deadIndex] = replacement;
          } else {
            workers.push(replacement);
          }
          attachDiedHandler(replacement, label);
          Logger.info(`Worker ${label} replacement created`);
        })
        .catch((err) => {
          Logger.error(
            `Failed to recreate dead worker ${label}: ${String(err)}`,
          );
        });
    });
  };

  const workerCount = getWorkerCount();
  Logger.info(`Creating ${workerCount} mediasoup worker(s)`);
  for (let i = 0; i < workerCount; i++) {
    const worker = await spawnWorker();
    attachDiedHandler(worker, String(i));
    workers.push(worker);
    Logger.info(`Worker ${i} created`);
  }

  return workers;
};

export default createWorkers;
