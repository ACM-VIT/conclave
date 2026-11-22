type WorkerSizing = {
  workerCount: number | undefined;
  hostInstanceCount: number;
  webRtcPortBudget: number | undefined;
};

type WorkerEnvironment = Readonly<Record<string, string | null | undefined>>;

export function readRtcPortRange(
  environment: WorkerEnvironment,
  defaults?: Partial<Record<"RTC_MIN_PORT" | "RTC_MAX_PORT", string>>,
): { rtcMinPort: number; rtcMaxPort: number };

export function readWorkerSizing(
  environment: WorkerEnvironment,
): WorkerSizing;

export function resolveWebRtcPortBudget(
  settings: Pick<WorkerSizing, "workerCount" | "webRtcPortBudget"> & {
    rtcMinPort: number;
    rtcMaxPort: number;
  },
): number;
