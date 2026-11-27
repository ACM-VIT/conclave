import { resolveWebRtcPortBudget } from "../config/workerSettings.mjs";
import { getMemoryLimitBytes, instanceCpuCount } from "./workerCpuQuota.js";

const MIB = 1024 * 1024;
const APP_DOCUMENT_MEMORY_SHARE = 0.25;
const MIN_OLD_GENERATION_MB = 128;
const MAX_OLD_GENERATION_MB = 1024;
const MIN_YOUNG_GENERATION_MB = 8;
const MAX_YOUNG_GENERATION_MB = 32;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export type WorkerPlanSettings = {
  workerCount: number | undefined;
  hostInstanceCount: number;
  webRtcPortBudget: number | undefined;
  appDocumentWorkerCount: number;
  rtcMinPort: number;
  rtcMaxPort: number;
};

export type AppDocumentHeap = { shareMb: number; oldMb: number; youngMb: number };

const appDocumentHeap = (memoryBytes: number, instances: number, workers: number): AppDocumentHeap => {
  const shareMb = Math.floor((memoryBytes * APP_DOCUMENT_MEMORY_SHARE) / instances / workers / MIB);
  const youngMb = clamp(Math.floor(shareMb / 8), MIN_YOUNG_GENERATION_MB, MAX_YOUNG_GENERATION_MB);
  return { shareMb, youngMb, oldMb: clamp(shareMb - youngMb, MIN_OLD_GENERATION_MB, MAX_OLD_GENERATION_MB) };
};

export type WorkerPlan = {
  cpus: number;
  mediasoupWorkers: number;
  cpuMediasoupWorkers: number;
  appDocumentWorkers: number;
  appDocumentHeap: AppDocumentHeap;
  webRtcPortBudget: number;
  rtcMinPort: number;
  rtcMaxPort: number;
  plainMinPort: number;
  sizing: "derived" | "configured";
  oversubscribed: boolean;
};

export const planWorkers = (
  settings: WorkerPlanSettings,
  cpus: number = instanceCpuCount(settings.hostInstanceCount),
  memoryBytes: number = getMemoryLimitBytes(),
): WorkerPlan => {
  const webRtcPortBudget = resolveWebRtcPortBudget(settings);
  const share = Math.max(cpus, 2);
  const configured = settings.workerCount;
  const appDocumentWorkers = settings.appDocumentWorkerCount;
  const allowedAppWorkers = Math.max(1, share - (configured ?? 1));
  if (appDocumentWorkers > allowedAppWorkers) {
    throw new Error(
      `SFU_APP_DOC_WORKERS=${appDocumentWorkers} leaves no CPU for ${configured ?? 1} mediasoup worker(s) in this instance's share of ${cpus} CPU(s); use at most ${allowedAppWorkers}`,
    );
  }
  const cpuMediasoupWorkers = configured ?? share - appDocumentWorkers;
  const mediasoupWorkers = Math.min(cpuMediasoupWorkers, webRtcPortBudget);
  return {
    cpus,
    mediasoupWorkers,
    cpuMediasoupWorkers,
    appDocumentWorkers,
    appDocumentHeap: appDocumentHeap(memoryBytes, settings.hostInstanceCount, appDocumentWorkers),
    webRtcPortBudget,
    rtcMinPort: settings.rtcMinPort,
    rtcMaxPort: settings.rtcMaxPort,
    plainMinPort:
      settings.rtcMinPort + (settings.webRtcPortBudget === undefined ? mediasoupWorkers : webRtcPortBudget),
    sizing: configured === undefined ? "derived" : "configured",
    oversubscribed: mediasoupWorkers + appDocumentWorkers > share,
  };
};
