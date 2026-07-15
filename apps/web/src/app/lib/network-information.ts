type BrowserNetworkQuality = "good" | "fair" | "poor" | "unknown";

export type BrowserNetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
  addEventListener?: (
    type: "change",
    listener: () => void,
  ) => void;
  removeEventListener?: (
    type: "change",
    listener: () => void,
  ) => void;
};

type NavigatorWithNetworkInformation = Navigator & {
  connection?: BrowserNetworkInformation;
  mozConnection?: BrowserNetworkInformation;
  webkitConnection?: BrowserNetworkInformation;
  userAgentData?: {
    mobile?: boolean;
  };
};

export type BrowserNetworkSnapshot = {
  supported: boolean;
  quality: BrowserNetworkQuality;
  startupQuality: BrowserNetworkQuality;
  emergency: boolean;
  effectiveType: string | null;
  saveData: boolean | null;
  downlinkMbps: number | null;
  rttMs: number | null;
};

export const BROWSER_NETWORK_POLICY_OBSERVATION_VERSION = 1;

export type BrowserNetworkPolicyObservation = {
  version: typeof BROWSER_NETWORK_POLICY_OBSERVATION_VERSION;
  source: "useConnectionQuality";
  observedAtEpochMs: number;
  browserNetwork: Readonly<BrowserNetworkSnapshot>;
};

export type BrowserNetworkPollAuthority = Readonly<{
  begin: () => number;
  isCurrent: (generation: number) => boolean;
  invalidate: () => void;
}>;

/**
 * Makes overlapping asynchronous stats polls latest-request-wins. A Network
 * Information change can arrive while getStats() is pending; the older poll
 * must not publish its stale browser snapshot after the newer request begins.
 */
export function createBrowserNetworkPollAuthority(): BrowserNetworkPollAuthority {
  let latestGeneration = 0;
  return Object.freeze({
    begin: () => {
      latestGeneration += 1;
      return latestGeneration;
    },
    isCurrent: (generation) => generation === latestGeneration,
    invalidate: () => {
      latestGeneration += 1;
    },
  });
}

/**
 * Product-owned evidence that the real connection-quality policy consumed a
 * browser Network Information snapshot. The quality harness may inject the
 * browser API, but it cannot mint this observation: only the application poll
 * that drives publish/receive adaptation calls this helper.
 */
export function buildBrowserNetworkPolicyObservation(
  browserNetwork: BrowserNetworkSnapshot,
  observedAtEpochMs = Date.now(),
): Readonly<BrowserNetworkPolicyObservation> {
  if (!Number.isFinite(observedAtEpochMs) || observedAtEpochMs < 0) {
    throw new TypeError("browser network observation epoch must be non-negative");
  }
  return Object.freeze({
    version: BROWSER_NETWORK_POLICY_OBSERVATION_VERSION,
    source: "useConnectionQuality",
    observedAtEpochMs,
    browserNetwork: Object.freeze({ ...browserNetwork }),
  });
}

const isFinitePositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const browserNetworkQualityRank: Record<BrowserNetworkQuality, number> = {
  unknown: 0,
  good: 1,
  fair: 2,
  poor: 3,
};

const MOBILE_USER_AGENT_PATTERN =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i;

export const isLikelyMobileOrTabletNavigator = (): boolean => {
  if (typeof navigator === "undefined") return false;

  const networkNavigator = navigator as NavigatorWithNetworkInformation;
  if (networkNavigator.userAgentData?.mobile === true) return true;

  const userAgent = navigator.userAgent;
  if (MOBILE_USER_AGENT_PATTERN.test(userAgent)) return true;

  // iPadOS can present a desktop-style Macintosh user agent in Safari.
  return /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
};

export function getBrowserNetworkInformation():
  | BrowserNetworkInformation
  | undefined {
  if (typeof navigator === "undefined") return undefined;
  const networkNavigator = navigator as NavigatorWithNetworkInformation;
  return (
    networkNavigator.connection ??
    networkNavigator.mozConnection ??
    networkNavigator.webkitConnection
  );
}

function classifyBrowserNetworkQuality(
  connection = getBrowserNetworkInformation(),
): BrowserNetworkQuality {
  if (!connection) {
    return "unknown";
  }
  if (connection.saveData === true) return "poor";

  let quality: BrowserNetworkQuality = "unknown";
  const mark = (next: Exclude<BrowserNetworkQuality, "unknown">) => {
    if (browserNetworkQualityRank[next] > browserNetworkQualityRank[quality]) {
      quality = next;
    }
  };

  const effectiveType = connection.effectiveType?.toLowerCase();
  if (effectiveType === "slow-2g" || effectiveType === "2g") {
    mark("poor");
  } else if (effectiveType === "3g") {
    mark("fair");
  } else if (effectiveType === "4g") {
    mark("good");
  }

  if (isFinitePositiveNumber(connection.downlink)) {
    if (connection.downlink <= 0.8) {
      mark("poor");
    } else if (connection.downlink <= 1.5) {
      mark("fair");
    } else {
      mark("good");
    }
  }

  if (isFinitePositiveNumber(connection.rtt)) {
    if (connection.rtt >= 700) {
      mark("poor");
    } else if (connection.rtt >= 350) {
      mark("fair");
    } else {
      mark("good");
    }
  }

  return quality;
}

function getBrowserNetworkStartupQuality(
  connection = getBrowserNetworkInformation(),
): BrowserNetworkQuality {
  const quality = classifyBrowserNetworkQuality(connection);
  if (quality !== "unknown") return quality;

  // Browsers such as Safari do not expose Network Information. Start mobile and
  // tablet capture conservatively, but keep measured quality unknown so WebRTC
  // stats can restore full quality on strong links.
  if (!connection && isLikelyMobileOrTabletNavigator()) return "fair";

  return "unknown";
}

function isEmergencyBrowserNetwork(
  connection = getBrowserNetworkInformation(),
): boolean {
  if (!connection) return false;
  const effectiveType = connection.effectiveType?.toLowerCase();
  if (effectiveType === "slow-2g") return true;

  const downlink = isFinitePositiveNumber(connection.downlink)
    ? connection.downlink
    : null;
  const rtt = isFinitePositiveNumber(connection.rtt) ? connection.rtt : null;

  return (
    (downlink !== null && downlink <= 0.3) ||
    (rtt !== null && rtt >= 850) ||
    (connection.saveData === true &&
      downlink !== null &&
      downlink <= 0.35 &&
      rtt !== null &&
      rtt >= 750)
  );
}

export function getBrowserNetworkSnapshot(): BrowserNetworkSnapshot {
  const connection = getBrowserNetworkInformation();
  const quality = classifyBrowserNetworkQuality(connection);
  return {
    supported: Boolean(connection),
    quality,
    startupQuality: getBrowserNetworkStartupQuality(connection),
    emergency: isEmergencyBrowserNetwork(connection),
    effectiveType:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : null,
    saveData:
      typeof connection?.saveData === "boolean" ? connection.saveData : null,
    downlinkMbps: isFinitePositiveNumber(connection?.downlink)
      ? connection.downlink
      : null,
    rttMs: isFinitePositiveNumber(connection?.rtt) ? connection.rtt : null,
  };
}

export function shouldStartLowBandwidthVideo(
  connection = getBrowserNetworkInformation(),
): boolean {
  if (!connection) return isLikelyMobileOrTabletNavigator();
  if (connection.saveData === true) return true;
  const effectiveType = connection.effectiveType?.toLowerCase();
  if (
    effectiveType === "slow-2g" ||
    effectiveType === "2g" ||
    effectiveType === "3g"
  ) {
    return true;
  }
  // Start conservatively only from capacity evidence. A long but otherwise
  // clean network path cannot be repaired by discarding camera pixels.
  return (
    isFinitePositiveNumber(connection.downlink) && connection.downlink <= 1.5
  );
}

export function shouldDeferBandwidthHeavyPreload(
  connection = getBrowserNetworkInformation(),
): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (!connection) return isLikelyMobileOrTabletNavigator();
  if (connection.saveData === true) return true;
  const quality = classifyBrowserNetworkQuality(connection);
  return (
    isEmergencyBrowserNetwork(connection) ||
    quality === "fair" ||
    quality === "poor"
  );
}
