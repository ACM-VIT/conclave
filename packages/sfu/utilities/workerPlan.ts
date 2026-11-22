import { resolveWebRtcPortBudget } from "../config/workerSettings.mjs";
import { instanceCpuCount } from "./workerCpuQuota.js";

export type WorkerPlanSettings = {
  workerCount: number | undefined;
  hostInstanceCount: number;
  webRtcPortBudget: number | undefined;
  appDocumentWorkerCount: number;
  rtcMinPort: number;
  rtcMaxPort: number;
};

export type WorkerPlan = {
  cpus: number;
  mediasoupWorkers: number;
  cpuMediasoupWorkers: number;
  appDocumentWorkers: number;
  webRtcPortBudget: number;
  plainMinPort: number;
  sizing: "derived" | "configured";
  oversubscribed: boolean;
};

export const planWorkers = (
  settings: WorkerPlanSettings,
  cpus: number = instanceCpuCount(settings.hostInstanceCount),
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
    webRtcPortBudget,
    plainMinPort:
      settings.rtcMinPort + (settings.webRtcPortBudget === undefined ? mediasoupWorkers : webRtcPortBudget),
    sizing: configured === undefined ? "derived" : "configured",
    oversubscribed: mediasoupWorkers + appDocumentWorkers > share,
  };
};
