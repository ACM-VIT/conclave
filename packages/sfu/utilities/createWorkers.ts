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
  signal?: AbortSignal;
};

const INITIAL_RESPAWN_DELAY_MS = 100;
const MAX_RESPAWN_DELAY_MS = 2000;

const webRtcServers = new WeakMap<Worker, WebRtcServer>();

export const getWorkerWebRtcServer = (worker: Worker): WebRtcServer | undefined =>
  webRtcServers.get(worker);

const spawnWorker = async (
  port: number,
  plainMinPort: number,
  signal?: AbortSignal,
): Promise<Worker> => {
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    const server = await worker.createWebRtcServer({ listenInfos });
    signal?.throwIfAborted();
    webRtcServers.set(worker, server);
    return worker;
  } catch (error) {
    worker.close();
    throw error;
  }
};

const respawnWorker = async (
  port: number,
  plainMinPort: number,
  signal?: AbortSignal,
): Promise<Worker> => {
  let delayMs = INITIAL_RESPAWN_DELAY_MS;
  for (;;) {
    try {
      return await spawnWorker(port, plainMinPort, signal);
    } catch (error) {
      signal?.throwIfAborted();
      Logger.warn(`Worker on WebRTC port ${port} failed to respawn; retrying in ${delayMs} ms`, error);
    }
    await delay(delayMs, undefined, { signal, ref: false });
    delayMs = Math.min(delayMs * 2, MAX_RESPAWN_DELAY_MS);
  }
};

const createWorkers = async (
  options: CreateWorkersOptions = {},
): Promise<Worker[]> => {
  const workers: Worker[] = [];
  const startupFailure = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, startupFailure.signal])
    : startupFailure.signal;
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

  // Placement skips closed workers. Keep their slots so recovery keeps the
  // same port and worker index while other slots continue serving rooms.
  const attachDiedHandler = (worker: Worker, index: number): void => {
    const label = String(index);
    worker.once("died", () => {
      if (signal?.aborted) return;
      Logger.error(`Worker ${label} has died; recreating a replacement`);
      void Promise.resolve().then(() => options.onWorkerDied?.(worker, label)).catch(
        (error) => {
          Logger.error(
            `Failed to clean up rooms for dead worker ${label}: ${String(error)}`,
          );
        },
      );
      respawnWorker(webRtcPortBase + index, plainMinPort, signal)
        .then((replacement) => {
          if (signal?.aborted) {
            replacement.close();
            return;
          }
          workers[index] = replacement;
          attachDiedHandler(replacement, index);
          Logger.info(`Worker ${label} replacement created`);
        })
        .catch((err) => {
          if (signal?.aborted) return;
          Logger.error(
            `Failed to recreate dead worker ${label}: ${String(err)}`,
          );
        });
    });
  };

  Logger.info(`Creating ${workerCount} mediasoup worker(s)`);
  try {
    for (let i = 0; i < workerCount; i++) {
      const worker = await spawnWorker(webRtcPortBase + i, plainMinPort, signal);
      workers.push(worker);
      attachDiedHandler(worker, i);
      Logger.info(`Worker ${i} created`);
    }
  } catch (error) {
    startupFailure.abort();
    for (const worker of workers) worker.close();
    throw error;
  }

  return workers;
};

export default createWorkers;
