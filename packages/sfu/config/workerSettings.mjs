// Shared-browser audio and video each use separate RTP and RTCP ports.
const SHARED_BROWSER_PLAIN_PORT_RESERVE = 4;

const readPositiveInteger = (env, name) => {
  const value = env[name];
  if (value === undefined || value === null) return undefined;
  const digits = typeof value === "string" ? value.trim() : "";
  const parsed = Number(digits);
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const readWorkerSizing = (environment) => ({
  workerCount: readPositiveInteger(environment, "SFU_WORKER_COUNT"),
  hostInstanceCount: readPositiveInteger(environment, "SFU_WORKER_HOST_INSTANCES") ?? 1,
  webRtcPortBudget: readPositiveInteger(environment, "SFU_WEBRTC_PORT_BUDGET"),
});

export const resolveWebRtcPortBudget = ({ rtcMinPort, rtcMaxPort, workerCount, webRtcPortBudget }) => {
  const rangeBudget = rtcMaxPort - rtcMinPort + 1 - SHARED_BROWSER_PLAIN_PORT_RESERVE;
  if (rangeBudget < 1) {
    throw new Error(`RTC_MIN_PORT through RTC_MAX_PORT must fit at least one worker port and ${SHARED_BROWSER_PLAIN_PORT_RESERVE} plain RTP ports`);
  }
  const effectiveBudget = Math.min(webRtcPortBudget ?? rangeBudget, rangeBudget);
  if (workerCount !== undefined && workerCount > effectiveBudget) {
    throw new Error(`SFU_WORKER_COUNT=${workerCount} exceeds the WebRTC port budget of ${effectiveBudget} with ${SHARED_BROWSER_PLAIN_PORT_RESERVE} ports reserved for plain RTP`);
  }
  return effectiveBudget;
};
