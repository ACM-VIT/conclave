// Shared-browser audio and video each use separate RTP and RTCP ports.
const SHARED_BROWSER_PLAIN_PORT_RESERVE = 4;

const parseDecimalInteger = (value) => {
  const digits = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
};

const readPositiveInteger = (env, name) => {
  const value = env[name];
  if (value === undefined || value === null) return undefined;
  const parsed = parseDecimalInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseRtcPort = (value, name) => {
  const port = parseDecimalInteger(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  return port;
};

export const readRtcPortRange = (environment, defaults = {}) => {
  const rtcMinPort = parseRtcPort(environment.RTC_MIN_PORT ?? defaults.RTC_MIN_PORT, "RTC_MIN_PORT");
  const rtcMaxPort = parseRtcPort(environment.RTC_MAX_PORT ?? defaults.RTC_MAX_PORT, "RTC_MAX_PORT");
  if (rtcMaxPort < rtcMinPort) {
    throw new Error("RTC_MAX_PORT must be greater than or equal to RTC_MIN_PORT.");
  }
  return { rtcMinPort, rtcMaxPort };
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
