type WorkerSizing = {
  workerCount: number | undefined;
  hostInstanceCount: number;
  webRtcPortBudget: number | undefined;
};

export function readWorkerSizing(
  environment: Readonly<Record<string, string | null | undefined>>,
): WorkerSizing;

export function resolveWebRtcPortBudget(
  settings: Pick<WorkerSizing, "workerCount" | "webRtcPortBudget"> & {
    rtcMinPort: number;
    rtcMaxPort: number;
  },
): number;
