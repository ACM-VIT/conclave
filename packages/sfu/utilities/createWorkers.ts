import { setTimeout as delay } from "node:timers/promises";
import * as mediasoup from "mediasoup";
import type { TransportListenInfo, WebRtcServer, Worker } from "mediasoup/types";
import type { config } from "../config/config.js";
import { Logger } from "./loggers.js";
import type { WorkerPlan } from "./workerPlan.js";

type WorkerMedia = {
  plan: WorkerPlan;
  settings: Pick<typeof config.workerSettings, "logLevel" | "logTags">;
  transport: Pick<typeof config.webRtcTransport, "enableUdp" | "enableTcp" | "listenIps">;
};

type CreateWorkersOptions = WorkerMedia & {
  onWorkerDied?: (worker: Worker, label: string) => void | Promise<void>;
  signal?: AbortSignal;
};

const INITIAL_RESPAWN_DELAY_MS = 100;
const MAX_RESPAWN_DELAY_MS = 2000;

const webRtcServers = new WeakMap<Worker, WebRtcServer>();

export const getWorkerWebRtcServer = (worker: Worker): WebRtcServer | undefined =>
  webRtcServers.get(worker);

const spawnWorker = async (
  media: WorkerMedia,
  port: number,
  signal?: AbortSignal,
): Promise<Worker> => {
  signal?.throwIfAborted();
  const worker = await mediasoup.createWorker({
    rtcMinPort: media.plan.plainMinPort,
    rtcMaxPort: media.plan.rtcMaxPort,
    logLevel: media.settings.logLevel,
    logTags: media.settings.logTags,
  });
  const { enableUdp, enableTcp, listenIps: [{ ip, announcedIp }] } = media.transport;
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
    if (error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message)) {
      throw new Error(
        `WebRTC port ${port} is already in use. On Linux, an outbound socket may have claimed an ephemeral port. Check net.ipv4.ip_local_reserved_ports on the SFU host.`,
        { cause: error },
      );
    }
    throw error;
  }
};

const respawnWorker = async (
  media: WorkerMedia,
  port: number,
  signal?: AbortSignal,
): Promise<Worker> => {
  let delayMs = INITIAL_RESPAWN_DELAY_MS;
  for (;;) {
    try {
      return await spawnWorker(media, port, signal);
    } catch (error) {
      signal?.throwIfAborted();
      Logger.warn(`Worker on WebRTC port ${port} failed to respawn; retrying in ${delayMs} ms`, error);
    }
    await delay(delayMs, undefined, { signal, ref: false });
    delayMs = Math.min(delayMs * 2, MAX_RESPAWN_DELAY_MS);
  }
};

const createWorkers = async (
  options: CreateWorkersOptions,
): Promise<Worker[]> => {
  const workers: Worker[] = [];
  const startupFailure = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, startupFailure.signal])
    : startupFailure.signal;
  const { plan } = options;
  const { rtcMinPort, mediasoupWorkers: workerCount } = plan;
  if (plan.cpuMediasoupWorkers > workerCount) {
    Logger.warn(`CPU capacity allows ${plan.cpuMediasoupWorkers} workers. Capping the derived count at the WebRTC port budget of ${plan.webRtcPortBudget}.`);
  }
  if (plan.oversubscribed) {
    Logger.warn(
      `SFU_WORKER_COUNT=${workerCount} and ${plan.appDocumentWorkers} app document worker(s) need more than the ${plan.cpus} CPU(s) in this instance's share`,
    );
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
      respawnWorker(options, rtcMinPort + index, signal)
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

  const sizing = plan.sizing === "derived"
    ? `derived from a ${plan.cpus}-CPU share beside ${plan.appDocumentWorkers} app document worker(s)`
    : "configured";
  console.log(`[SFU] Creating ${workerCount} mediasoup worker(s) (${sizing})`);
  try {
    for (let i = 0; i < workerCount; i++) {
      const worker = await spawnWorker(options, rtcMinPort + i, signal);
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
