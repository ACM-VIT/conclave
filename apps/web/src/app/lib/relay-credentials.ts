const TURN_URL_PATTERN = /^turns?:/i;

const buildIceServerWithUrls = (
  iceServer: RTCIceServer,
  urls: string[],
): RTCIceServer => ({
  ...iceServer,
  urls: urls.length === 1 ? urls[0] : urls,
});

export const normalizeIceServerUrls = (
  urls: RTCIceServer["urls"] | undefined,
): string[] => {
  if (!urls) return [];
  const normalizedUrls = (Array.isArray(urls) ? urls : [urls])
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(normalizedUrls));
};

export const splitIceServersByType = (
  iceServers: RTCIceServer[] | null | undefined,
): { stunIceServers: RTCIceServer[]; turnIceServers: RTCIceServer[] } => {
  const stunIceServers: RTCIceServer[] = [];
  const turnIceServers: RTCIceServer[] = [];

  for (const iceServer of iceServers ?? []) {
    const urls = normalizeIceServerUrls(iceServer.urls);
    if (urls.length === 0) continue;

    const turnUrls = urls.filter((url) => TURN_URL_PATTERN.test(url));
    const stunUrls = urls.filter((url) => !TURN_URL_PATTERN.test(url));

    if (stunUrls.length > 0) {
      stunIceServers.push(buildIceServerWithUrls(iceServer, stunUrls));
    }
    if (turnUrls.length > 0) {
      turnIceServers.push(buildIceServerWithUrls(iceServer, turnUrls));
    }
  }

  return { stunIceServers, turnIceServers };
};

/** The ICE servers new transports are offered, from the join answers so far. */
export type RuntimeIceServers = {
  stun: RTCIceServer[] | null;
  turn: RTCIceServer[] | null;
  /** When `turn`'s credentials run out; null when the answer gave no lifetime. */
  turnExpiresAt: number | null;
};

export const NO_RUNTIME_ICE_SERVERS: RuntimeIceServers = {
  stun: null,
  turn: null,
  turnExpiresAt: null,
};

/** TURN credentials this close to expiry are no longer handed out. */
const RELAY_USABLE_MARGIN_MS = 5_000;
/** A reconnect asks for new TURN credentials once the held ones are this close. */
const RELAY_REFRESH_MARGIN_MS = 60_000;

export const isRelayUsable = (expiresAt: number | null, now: number): boolean =>
  expiresAt === null || expiresAt - now > RELAY_USABLE_MARGIN_MS;

export const isRelayDueForRefresh = (
  expiresAt: number | null,
  now: number,
): boolean => expiresAt !== null && expiresAt - now <= RELAY_REFRESH_MARGIN_MS;

/** TURN servers whose credentials still have time left, or null. */
export const getUsableTurnIceServers = (
  servers: RuntimeIceServers,
  now: number,
): RTCIceServer[] | null =>
  servers.turn && isRelayUsable(servers.turnExpiresAt, now) ? servers.turn : null;

/**
 * The ICE servers to offer after a join answer. A route whose TURN provider
 * is down answers with STUN only, so an answer without a usable relay keeps
 * the TURN credentials already held for as long as they last.
 */
export const applyJoinAnswerToIceServers = (
  current: RuntimeIceServers,
  answer: { iceServers: RTCIceServer[]; relayExpiresAt: number | null },
  now: number,
): RuntimeIceServers => {
  const { stunIceServers, turnIceServers } = splitIceServersByType(
    answer.iceServers,
  );
  const stun = stunIceServers.length > 0 ? stunIceServers : null;
  if (turnIceServers.length > 0 && isRelayUsable(answer.relayExpiresAt, now)) {
    return { stun, turn: turnIceServers, turnExpiresAt: answer.relayExpiresAt };
  }
  return getUsableTurnIceServers(current, now)
    ? { stun, turn: current.turn, turnExpiresAt: current.turnExpiresAt }
    : { stun, turn: null, turnExpiresAt: null };
};
