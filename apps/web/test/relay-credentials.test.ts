import { describe, expect, it } from "vitest";
import {
  NO_RUNTIME_ICE_SERVERS,
  applyJoinAnswerToIceServers,
  getUsableTurnIceServers,
  noteRelayCarryingMedia,
  offerRelays,
  relayCarryingUrl,
  readRelayPairBytes,
  relayProvenByMedia,
  type RuntimeIceServers,
} from "../src/app/lib/relay-credentials";

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const HOUR_MS = 60 * 60_000;
const stun = { urls: "stun:stun.example:3478" };
const turnA = { urls: "turn:turn.example:3478", username: "a", credential: "a" };
const turnB = { urls: "turns:turn.example:5349", username: "b", credential: "b" };

const holding = (expiresAt: number | null): RuntimeIceServers => ({
  stun: [stun],
  latestRelay: { servers: [turnA], expiresAt },
  provenRelay: null,
});

const offered = (
  current: RuntimeIceServers,
  answer: { iceServers: RTCIceServer[]; relayExpiresAt: number | null },
) => {
  const next = applyJoinAnswerToIceServers(current, answer, NOW);
  return { stun: next.stun, turn: getUsableTurnIceServers(next, NOW) };
};

describe("ICE servers after a join answer", () => {
  it("takes the answer's TURN credentials", () => {
    expect(
      offered(holding(NOW + HOUR_MS), {
        iceServers: [stun, turnB],
        relayExpiresAt: NOW + 2 * HOUR_MS,
      }),
    ).toEqual({ stun: [stun], turn: [turnB] });
  });

  it("keeps unexpired TURN credentials when an answer brings no relay", () => {
    expect(
      offered(holding(NOW + HOUR_MS), { iceServers: [stun], relayExpiresAt: null }),
    ).toEqual({ stun: [stun], turn: [turnA] });
  });

  it("keeps TURN credentials with no known lifetime when an answer brings no relay", () => {
    expect(
      offered(holding(null), { iceServers: [stun], relayExpiresAt: null }).turn,
    ).toEqual([turnA]);
  });

  it("drops expired TURN credentials when an answer brings no relay", () => {
    expect(
      offered(holding(NOW + 2_000), { iceServers: [stun], relayExpiresAt: null }),
    ).toEqual({ stun: [stun], turn: null });
  });

  it("uses a fresh answer's short-lived TURN credentials", () => {
    expect(
      offered(NO_RUNTIME_ICE_SERVERS, {
        iceServers: [stun, turnB],
        relayExpiresAt: NOW + 60_000,
      }).turn,
    ).toEqual([turnB]);
  });

  it("keeps held TURN credentials with under a minute left over an answer without a relay", () => {
    expect(
      offered(holding(NOW + 45_000), { iceServers: [stun], relayExpiresAt: null }).turn,
    ).toEqual([turnA]);
  });

  it("ignores an answer's TURN credentials that have already expired", () => {
    expect(
      offered(NO_RUNTIME_ICE_SERVERS, {
        iceServers: [stun, turnB],
        relayExpiresAt: NOW - 1_000,
      }),
    ).toEqual({ stun: [stun], turn: null });
  });

  it("keeps the current relay over an answer whose own relay has expired", () => {
    expect(
      offered(holding(NOW + HOUR_MS), {
        iceServers: [stun, turnB],
        relayExpiresAt: NOW - 1_000,
      }).turn,
    ).toEqual([turnA]);
  });
});

describe("a relay that is carrying media", () => {
  const urlA = "turn:127.0.0.1:30603?transport=udp";
  const urlB = "turn:127.0.0.1:30606?transport=udp";
  const relayA = { urls: urlA, username: "a", credential: "a" };
  const relayB = { urls: urlB, username: "b", credential: "b" };
  const provenA: RuntimeIceServers = {
    stun: [stun],
    latestRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS },
    provenRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS },
  };
  const rotatedToB = applyJoinAnswerToIceServers(
    provenA,
    { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS },
    NOW,
  );
  const carriedOver = (servers: RuntimeIceServers, url: string, at = NOW) => {
    const carrier = relayCarryingUrl(offerRelays(servers, at), url);
    return carrier ? noteRelayCarryingMedia(servers, carrier, at) : servers;
  };

  it("is still offered when a new answer brings another relay", () => {
    expect(getUsableTurnIceServers(rotatedToB, NOW)).toEqual([relayB, relayA]);
  });

  it("stays offered while transports keep carrying media through it", () => {
    expect(getUsableTurnIceServers(carriedOver(rotatedToB, urlA), NOW)).toEqual([relayB, relayA]);
  });

  it("is dropped once the new relay has carried media", () => {
    expect(getUsableTurnIceServers(carriedOver(rotatedToB, urlB), NOW)).toEqual([relayB]);
  });

  it("is no longer offered once it expires", () => {
    const next = applyJoinAnswerToIceServers(
      { ...provenA, provenRelay: { servers: [relayA], expiresAt: NOW + 2_000 } },
      { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS },
      NOW,
    );

    expect(getUsableTurnIceServers(next, NOW)).toEqual([relayB]);
  });
});

describe("refreshed credentials for the same relay URL", () => {
  const url = "turn:127.0.0.1:30603?transport=udp";
  const older = { urls: url, username: "1700000000:guest", credential: "old" };
  const fresher = { urls: url, username: "1700003600:guest", credential: "new" };
  const refreshed: RuntimeIceServers = {
    stun: [stun],
    latestRelay: { servers: [fresher], expiresAt: NOW + HOUR_MS },
    provenRelay: { servers: [older], expiresAt: NOW + 30_000 },
  };

  it("offers one set of credentials per URL, the newest", () => {
    expect(getUsableTurnIceServers(refreshed, NOW)).toEqual([fresher]);
  });

  it("are proven by media even while the older credentials for that URL are proven", () => {
    const carrier = relayCarryingUrl(offerRelays(refreshed, NOW), url);
    const next = carrier ? noteRelayCarryingMedia(refreshed, carrier, NOW) : refreshed;

    expect(next.provenRelay).toBe(refreshed.latestRelay);
  });

  it("stay offered after the older credentials expire and a new answer brings another relay", () => {
    const carrier = relayCarryingUrl(offerRelays(refreshed, NOW), url);
    const proven = carrier ? noteRelayCarryingMedia(refreshed, carrier, NOW) : refreshed;
    const later = NOW + 60_000;
    const relayB = { urls: "turn:127.0.0.1:30606?transport=udp", username: "b", credential: "b" };

    expect(
      getUsableTurnIceServers(
        applyJoinAnswerToIceServers(
          proven,
          { iceServers: [stun, relayB], relayExpiresAt: later + HOUR_MS },
          later,
        ),
        later,
      ),
    ).toEqual([relayB, fresher]);
  });

  it("never credits credentials that have expired", () => {
    const expired = { servers: [older], expiresAt: NOW - 1_000 };

    expect(noteRelayCarryingMedia(refreshed, expired, NOW)).toBe(refreshed);
  });
});

describe("knowing that a relay works", () => {
  const relayA = "turn:127.0.0.1:30603?transport=udp";
  const relayB = "turn:127.0.0.1:30606?transport=udp";
  const pairs = (bytes: Record<string, number>, direction: "send" | "recv" = "recv") =>
    Object.entries(bytes).flatMap(([url, total], index) => [
      {
        type: "candidate-pair",
        id: `P${index}`,
        localCandidateId: `L${index}`,
        ...(direction === "recv" ? { bytesReceived: total } : { bytesSent: total }),
      },
      { type: "local-candidate", id: `L${index}`, candidateType: "relay", url },
    ]);

  it("reads each relay's bytes from its own candidate pairs", () => {
    expect(
      readRelayPairBytes(
        [
          ...pairs({ [relayA]: 1_000, [relayB]: 50 }),
          { type: "candidate-pair", id: "D", localCandidateId: "H", bytesReceived: 9_000 },
          { type: "local-candidate", id: "H", candidateType: "host" },
        ],
        "recv",
      ),
    ).toEqual({ [relayA]: 1_000, [relayB]: 50 });
    expect(readRelayPairBytes(pairs({ [relayA]: 700 }, "send"), "send")).toEqual({ [relayA]: 700 });
  });

  it("credits the relay whose pairs carried the media, whichever pair is selected when sampled", () => {
    expect(
      relayProvenByMedia({
        mediaBytes: 90_000,
        relayBytes: { [relayA]: 108_000, [relayB]: 770 },
        previousRelayBytes: { [relayA]: 0, [relayB]: 770 },
      }),
    ).toBe(relayA);
  });

  it("never credits a relay that only connected", () => {
    expect(
      relayProvenByMedia({
        mediaBytes: 0,
        relayBytes: { [relayB]: 770 },
        previousRelayBytes: { [relayB]: 0 },
      }),
    ).toBeNull();
  });

  it("credits no relay when the media went another way", () => {
    expect(
      relayProvenByMedia({
        mediaBytes: 90_000,
        relayBytes: { [relayB]: 1_500 },
        previousRelayBytes: { [relayB]: 770 },
      }),
    ).toBeNull();
  });

  it("needs a sample before it to measure against", () => {
    expect(
      relayProvenByMedia({
        mediaBytes: 90_000,
        relayBytes: { [relayA]: 108_000 },
        previousRelayBytes: null,
      }),
    ).toBeNull();
    expect(
      relayProvenByMedia({
        mediaBytes: 90_000,
        relayBytes: { [relayA]: 108_000 },
        previousRelayBytes: {},
      }),
    ).toBeNull();
  });

  it("keeps the working relay offered while a newer one has only connected", () => {
    const relayAServer = { urls: relayA, username: "a", credential: "a" };
    const relayBServer = { urls: relayB, username: "b", credential: "b" };
    const rotated = applyJoinAnswerToIceServers(
      {
        stun: [stun],
        latestRelay: { servers: [relayAServer], expiresAt: NOW + HOUR_MS },
        provenRelay: { servers: [relayAServer], expiresAt: NOW + HOUR_MS },
      },
      { iceServers: [stun, relayBServer], relayExpiresAt: NOW + HOUR_MS },
      NOW,
    );
    const proven = relayProvenByMedia({
      mediaBytes: 0,
      relayBytes: { [relayB]: 770 },
      previousRelayBytes: { [relayB]: 0 },
    });
    const next = proven ? noteRelayCarryingMedia(rotated, proven) : rotated;

    expect(getUsableTurnIceServers(next, NOW)).toEqual([relayBServer, relayAServer]);
  });
});
