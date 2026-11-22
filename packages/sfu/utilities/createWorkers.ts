import { setTimeout as delay } from "node:timers/promises";
import * as mediasoup from "mediasoup";
import type { TransportListenInfo, WebRtcServer, Worker } from "mediasoup/types";
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

const webRtcServers = new WeakMap<Worker, WebRtcServer>();

export const getWorkerWebRtcServer = (worker: Worker): WebRtcServer | undefined =>
  webRtcServers.get(worker);

const spawnWorker = async (port: number, plainMinPort: number): Promise<Worker> => {
  const worker = await mediasoup.createWorker({
    rtcMinPort: plainMinPort,
    rtcMaxPort: config.workerSettings.rtcMaxPort,
    logLevel: config.workerSettings.logLevel,
    logTags: config.workerSettings.logTags,
  });
  const { enableUdp, enableTcp, listenIps: [{ ip, announcedIp }] } = config.webRtcTransport;
  const listenInfos: TransportListenInfo[] = [];
  if (enableUdp) listenInfos.push({ protocol: "udp", ip, announcedAddress: announcedIp, port });
  if (enableTcp) listenInfos.push({ protocol: "tcp", ip, announcedAddress: announcedIp, port });
  try {
    const server = await worker.createWebRtcServer({ listenInfos });
    webRtcServers.set(worker, server);
    return worker;
  } catch (error) {
    worker.close();
    throw error;
  }
};

const respawnWorker = async (port: number, plainMinPort: number): Promise<Worker> => {
  for (const delayMs of [100, 200, 400]) {
    try {
      return await spawnWorker(port, plainMinPort);
    } catch (error) {
      Logger.warn(`Worker on WebRTC port ${port} failed to respawn; retrying in ${delayMs} ms`, error);
      await delay(delayMs);
    }
  }
  return spawnWorker(port, plainMinPort);
};

const createWorkers = async (
  options: CreateWorkersOptions = {},
): Promise<Worker[]> => {
  const workers: Worker[] = [];
  const workerCount = getWorkerCount();
  const { rtcMinPort, rtcMaxPort, webRtcPortBase } = config.workerSettings;
  if (!Number.isInteger(webRtcPortBase) || webRtcPortBase < rtcMinPort || webRtcPortBase > rtcMaxPort) {
    throw new Error("SFU_WEBRTC_PORT_BASE must be an integer between RTC_MIN_PORT and RTC_MAX_PORT");
  }
  const lastWebRtcPort = webRtcPortBase + workerCount - 1;
  const plainMinPort = webRtcPortBase === rtcMinPort ? lastWebRtcPort + 1 : rtcMinPort;
  if (
    lastWebRtcPort > 65535 ||
    plainMinPort > rtcMaxPort ||
    (webRtcPortBase <= rtcMaxPort && lastWebRtcPort >= plainMinPort)
  ) {
    throw new Error("Worker WebRTC ports must fit in 1-65535 without overlapping the plain RTP range");
  }

  // A dead mediasoup worker takes its routers - and the rooms running on them -
  // with it. Previously the handler did `process.exit(1)`, which killed the
  // WHOLE instance and every healthy room on the other workers too. Instead we
  // recreate a replacement worker IN PLACE so the pool stays full and new rooms
  // get allocated to a healthy worker. `workers` is the exact array stored on
  // `state.workers`, so mutating it here updates the live pool. Rooms that were
  // on the dead worker degrade (their producers/consumers error) and their
  // clients rejoin via the normal reconnect path, landing on a healthy worker.
  const attachDiedHandler = (worker: Worker, index: number): void => {
    const label = String(index);
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
      respawnWorker(webRtcPortBase + index, plainMinPort)
        .then((replacement) => {
          if (deadIndex >= 0) {
            workers[deadIndex] = replacement;
          } else {
            workers.push(replacement);
          }
          attachDiedHandler(replacement, index);
          Logger.info(`Worker ${label} replacement created`);
        })
        .catch((err) => {
          Logger.error(
            `Failed to recreate dead worker ${label}: ${String(err)}`,
          );
        });
    });
  };

  Logger.info(`Creating ${workerCount} mediasoup worker(s)`);
  for (let i = 0; i < workerCount; i++) {
    const worker = await spawnWorker(webRtcPortBase + i, plainMinPort);
    attachDiedHandler(worker, i);
    workers.push(worker);
    Logger.info(`Worker ${i} created`);
  }

  return workers;
};

export default createWorkers;
