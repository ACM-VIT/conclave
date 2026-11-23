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

/** One join answer's TURN servers and when their credentials run out. */
export type RelaySet = {
  servers: RTCIceServer[];
  /** Null when the answer gave no lifetime. */
  expiresAt: number | null;
};

/** The ICE servers new transports are offered, from the join answers so far. */
export type RuntimeIceServers = {
  stun: RTCIceServer[] | null;
  /** The relay from the newest answer that had a usable one. */
  latestRelay: RelaySet | null;
  /**
   * The relay a transport was last seen carrying media through. It stays on
   * offer next to a newer relay until that one has carried media too.
   */
  provenRelay: RelaySet | null;
};

export const NO_RUNTIME_ICE_SERVERS: RuntimeIceServers = {
  stun: null,
  latestRelay: null,
  provenRelay: null,
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

const usableRelay = (relay: RelaySet | null, now: number): RelaySet | null =>
  relay && isRelayUsable(relay.expiresAt, now) ? relay : null;

export type RelayOffer = { relay: RelaySet; servers: RTCIceServer[] };

const serverUrls = (servers: RTCIceServer[]): Set<string> =>
  new Set(servers.flatMap((server) => normalizeIceServerUrls(server.urls)));

export const offerRelays = (
  servers: RuntimeIceServers,
  now: number,
): RelayOffer[] => {
  const latest = usableRelay(servers.latestRelay, now);
  const proven = usableRelay(servers.provenRelay, now);
  const offers: RelayOffer[] = latest
    ? [{ relay: latest, servers: latest.servers }]
    : [];
  if (!proven || proven === latest) return offers;
  const taken = serverUrls(latest?.servers ?? []);
  const provenServers = proven.servers.filter(
    (server) => !normalizeIceServerUrls(server.urls).some((url) => taken.has(url)),
  );
  return provenServers.length > 0
    ? [...offers, { relay: proven, servers: provenServers }]
    : offers;
};

export const offeredTurnServers = (
  offers: RelayOffer[],
): RTCIceServer[] | null => {
  const servers = offers.flatMap((offer) => offer.servers);
  return servers.length > 0 ? servers : null;
};

export const relayCarryingUrl = (
  offers: RelayOffer[],
  url: string,
): RelaySet | null =>
  offers.find((offer) => serverUrls(offer.servers).has(url))?.relay ?? null;

export const getUsableTurnIceServers = (
  servers: RuntimeIceServers,
  now: number,
): RTCIceServer[] | null => offeredTurnServers(offerRelays(servers, now));

/**
 * The ICE servers to offer after a join answer. A route whose TURN provider
 * is down answers with STUN only, so an answer without a usable relay keeps
 * the newest relay already held for as long as it lasts. The relay last seen
 * carrying media is never replaced here; see noteRelayCarryingMedia.
 */
export const applyJoinAnswerToIceServers = (
  current: RuntimeIceServers,
  answer: { iceServers: RTCIceServer[]; relayExpiresAt: number | null },
  now: number,
): RuntimeIceServers => {
  const { stunIceServers, turnIceServers } = splitIceServersByType(
    answer.iceServers,
  );
  const answerRelay =
    turnIceServers.length > 0 && isRelayUsable(answer.relayExpiresAt, now)
      ? { servers: turnIceServers, expiresAt: answer.relayExpiresAt }
      : null;
  return {
    stun: stunIceServers.length > 0 ? stunIceServers : null,
    latestRelay: answerRelay ?? usableRelay(current.latestRelay, now),
    provenRelay: usableRelay(current.provenRelay, now),
  };
};

export const noteRelayCarryingMedia = (
  current: RuntimeIceServers,
  carrier: RelaySet,
  now: number,
): RuntimeIceServers =>
  carrier === current.provenRelay || !isRelayUsable(carrier.expiresAt, now)
    ? current
    : { ...current, provenRelay: carrier };

type StatsEntry = {
  type?: string;
  id?: string;
  localCandidateId?: string;
  candidateType?: string;
  url?: string;
  bytesReceived?: number;
  bytesSent?: number;
};

export const readRelayPairBytes = (
  stats: Iterable<StatsEntry>,
  direction: "send" | "recv",
): Record<string, number> => {
  const entries = [...stats];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const bytes: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.type !== "candidate-pair" || !entry.localCandidateId) continue;
    const local = byId.get(entry.localCandidateId);
    if (local?.candidateType !== "relay" || !local.url) continue;
    const url = local.url.trim();
    const total = direction === "recv" ? entry.bytesReceived : entry.bytesSent;
    bytes[url] = (bytes[url] ?? 0) + (total ?? 0);
  }
  return bytes;
};

export const relayProvenByMedia = ({
  mediaBytes,
  relayBytes,
  previousRelayBytes,
}: {
  mediaBytes: number;
  relayBytes: Record<string, number>;
  previousRelayBytes: Record<string, number> | null;
}): string | null => {
  if (mediaBytes <= 0 || !previousRelayBytes) return null;
  let carrier: string | null = null;
  let carried = 0;
  for (const [url, total] of Object.entries(relayBytes)) {
    const grown = total - (previousRelayBytes[url] ?? total);
    if (grown > carried) {
      carrier = url;
      carried = grown;
    }
  }
  return carrier !== null && carried * 2 >= mediaBytes ? carrier : null;
};
