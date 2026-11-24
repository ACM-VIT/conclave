import { describe, expect, it } from "vitest";
import {
  NO_RUNTIME_ICE_SERVERS,
  applyJoinAnswerToIceServers,
  getUsableTurnIceServers,
  RELAY_REFRESH_TRIES,
  icePolicyForOffers,
  noteRelayCarryingMedia,
  planRelayRefresh,
  takeRelayRefreshTry,
  transportsToMoveOntoRelay,
  type RelayRefreshChain,
  readAnswerRelay,
  stampJoinAnswer,
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
  latestRelay: { servers: [turnA], expiresAt, issuedAt: NOW - 60_000 },
  provenRelay: null,
});

const offered = (
  current: RuntimeIceServers,
  answer: { iceServers: RTCIceServer[]; relayExpiresAt?: number; relayIssuedAt?: number },
) => {
  const next = applyJoinAnswerToIceServers(current, { relayIssuedAt: NOW, ...answer }, NOW);
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
      offered(holding(NOW + HOUR_MS), { iceServers: [stun] }),
    ).toEqual({ stun: [stun], turn: [turnA] });
  });

  it("keeps TURN credentials with no known lifetime when an answer brings no relay", () => {
    expect(
      offered(holding(null), { iceServers: [stun] }).turn,
    ).toEqual([turnA]);
  });

  it("drops expired TURN credentials when an answer brings no relay", () => {
    expect(
      offered(holding(NOW + 2_000), { iceServers: [stun] }),
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
      offered(holding(NOW + 45_000), { iceServers: [stun] }).turn,
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
    latestRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 60_000 },
    provenRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 60_000 },
  };
  const rotatedToB = applyJoinAnswerToIceServers(
    provenA,
    { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS, relayIssuedAt: NOW },
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
      { ...provenA, provenRelay: { servers: [relayA], expiresAt: NOW + 2_000, issuedAt: NOW - 60_000 } },
      { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS, relayIssuedAt: NOW },
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
    latestRelay: { servers: [fresher], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 1_000 },
    provenRelay: { servers: [older], expiresAt: NOW + 30_000, issuedAt: NOW - HOUR_MS },
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
          { iceServers: [stun, relayB], relayExpiresAt: later + HOUR_MS, relayIssuedAt: later },
          later,
        ),
        later,
      ),
    ).toEqual([relayB, fresher]);
  });

  it("never credits credentials that have expired", () => {
    const expired = { servers: [older], expiresAt: NOW - 1_000, issuedAt: NOW - 2 * HOUR_MS };

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
        latestRelay: { servers: [relayAServer], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 60_000 },
        provenRelay: { servers: [relayAServer], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 60_000 },
      },
      { iceServers: [stun, relayBServer], relayExpiresAt: NOW + HOUR_MS, relayIssuedAt: NOW },
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

describe("the ICE policy a transport is built with", () => {
  const afterTurnOnlyRecovery = (expiresAt: number): RuntimeIceServers => ({
    stun: [stun],
    latestRelay: { servers: [turnA], expiresAt, issuedAt: NOW - 60_000 },
    provenRelay: { servers: [turnA], expiresAt, issuedAt: NOW - 60_000 },
  });

  it("asks for relay only while a usable relay is offered", () => {
    const servers = afterTurnOnlyRecovery(NOW + HOUR_MS);

    expect(icePolicyForOffers(true, offerRelays(servers, NOW))).toBe("relay");
    expect(icePolicyForOffers(false, offerRelays(servers, NOW))).toBe("all");
  });

  it("uses every candidate once the relay credentials expired and could not be refreshed", () => {
    const servers = afterTurnOnlyRecovery(NOW + 40_000);
    const later = NOW + 60_000;
    const offers = offerRelays(servers, later);

    expect(offers).toEqual([]);
    expect(icePolicyForOffers(true, offers)).toBe("all");
  });

  it("never asks for relay only with no relay at all", () => {
    expect(icePolicyForOffers(true, offerRelays(NO_RUNTIME_ICE_SERVERS, NOW))).toBe("all");
  });
});

describe("fetching TURN credentials again while relay only is wanted", () => {
  const wanted = { wanted: true, relayUsable: false } as const;

  it("starts a chain when a join answer comes back with STUN only", () => {
    expect(planRelayRefresh(null, { ...wanted, budget: "keep" })).toEqual({
      triesLeft: RELAY_REFRESH_TRIES,
    });
  });

  it("keeps a running chain going when its own answer has STUN only", () => {
    expect(planRelayRefresh({ triesLeft: 2 }, { ...wanted, budget: "keep" })).toEqual({
      triesLeft: 2,
    });
  });

  it("ends the chain once a relay is usable or relay only is no longer wanted", () => {
    expect(
      planRelayRefresh({ triesLeft: 2 }, { wanted: true, relayUsable: true, budget: "keep" }),
    ).toBeNull();
    expect(
      planRelayRefresh({ triesLeft: 2 }, { wanted: false, relayUsable: false, budget: "renew" }),
    ).toBeNull();
  });

  it("gives a new rebuild a fresh budget but never refills one from an answer", () => {
    expect(planRelayRefresh({ triesLeft: 0 }, { ...wanted, budget: "keep" })).toEqual({
      triesLeft: 0,
    });
    expect(planRelayRefresh({ triesLeft: 0 }, { ...wanted, budget: "renew" })).toEqual({
      triesLeft: RELAY_REFRESH_TRIES,
    });
  });

  const provider = (upFromTry: number | null) => {
    let chain: RelayRefreshChain = planRelayRefresh(null, { ...wanted, budget: "keep" });
    let tries = 0;
    while (chain && chain.triesLeft > 0) {
      chain = takeRelayRefreshTry(chain);
      tries += 1;
      const relayUsable = upFromTry !== null && tries >= upFromTry;
      chain = planRelayRefresh(chain, { wanted: true, relayUsable, budget: "keep" });
    }
    return { tries, chain };
  };

  it("keeps asking through a provider outage and stops at the first usable relay", () => {
    expect(provider(3)).toEqual({ tries: 3, chain: null });
  });

  it("stops after its budget while the provider stays down", () => {
    expect(provider(null)).toEqual({ tries: RELAY_REFRESH_TRIES, chain: { triesLeft: 0 } });
  });
});

describe("moving a transport onto the relay once one is usable", () => {
  const set = (issuedAt: number, expiresAt: number | null) => ({ servers: [turnA], expiresAt, issuedAt });
  const holdingRelay = (issuedAt: number, expiresAt: number | null): RuntimeIceServers => ({
    stun: [stun],
    latestRelay: set(issuedAt, expiresAt),
    provenRelay: null,
  });
  const transport = (offers: Array<ReturnType<typeof set>>, extra: { carriedMedia?: boolean; failed?: boolean } = {}) => ({
    direction: "consumer" as const,
    offers: offers.map((relay) => ({ relay, servers: relay.servers })),
    carriedMedia: extra.carriedMedia ?? false,
    failed: extra.failed ?? false,
  });
  const move = (servers: RuntimeIceServers, transports: Array<ReturnType<typeof transport>>, wanted = true) =>
    transportsToMoveOntoRelay({ wanted, servers, now: NOW, transports });

  it("moves a transport that was offered no relay and never carried media", () => {
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([])])).toEqual(["consumer"]);
  });

  it("moves a transport whose offered credentials expired before it carried media", () => {
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([set(NOW - 60_000, NOW - 1_000)])])).toEqual([
      "consumer",
    ]);
  });

  it("moves a failed transport once a newer generation than it was offered arrives", () => {
    const offered = set(NOW - 60_000, NOW + 30_000);
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([offered], { failed: true })])).toEqual(["consumer"]);
    expect(move(holdingRelay(NOW - 60_000, NOW + 30_000), [transport([offered], { failed: true })])).toEqual([]);
  });

  it("leaves a transport on credentials that are still valid while it has not failed", () => {
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([set(NOW - 60_000, NOW + 30_000)])])).toEqual([]);
  });

  it("never moves a transport that has carried media", () => {
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([], { carriedMedia: true })])).toEqual([]);
  });

  it("moves nothing while no relay is usable or relay only is not wanted", () => {
    expect(move(holdingRelay(NOW, NOW + 2_000), [transport([])])).toEqual([]);
    expect(move(holdingRelay(NOW, NOW + HOUR_MS), [transport([])], false)).toEqual([]);
  });
});


describe("one versioned set of TURN credentials", () => {
  const answer = (relayIssuedAt: number, relayExpiresAt: number) => ({
    iceServers: [stun, turnB],
    relayIssuedAt,
    relayExpiresAt,
  });

  it("never lets an older answer replace newer credentials", () => {
    const fresh = applyJoinAnswerToIceServers(NO_RUNTIME_ICE_SERVERS, answer(NOW, NOW + HOUR_MS), NOW);
    const older = { iceServers: [stun, turnA], relayIssuedAt: NOW - 60_000, relayExpiresAt: NOW + HOUR_MS };

    expect(applyJoinAnswerToIceServers(fresh, older, NOW).latestRelay).toBe(fresh.latestRelay);
  });

  it("keeps the expiry an answer was issued with when it is applied again later", () => {
    const stamped = stampJoinAnswer({ iceServers: [stun, turnB], iceServersTtlSeconds: 30 }, NOW);
    const later = NOW + 60_000;

    expect(readAnswerRelay(stamped)).toEqual({ servers: [turnB], expiresAt: NOW + 30_000, issuedAt: NOW });
    expect(getUsableTurnIceServers(applyJoinAnswerToIceServers(NO_RUNTIME_ICE_SERVERS, stamped, later), later)).toBeNull();
  });

  it("stamps an answer once and keeps the stamps it already has", () => {
    const stamped = stampJoinAnswer({ iceServers: [stun, turnB], relayIssuedAt: NOW - 5_000, relayExpiresAt: NOW + 1_000 }, NOW);

    expect(stamped).toMatchObject({ relayIssuedAt: NOW - 5_000, relayExpiresAt: NOW + 1_000 });
    expect(stampJoinAnswer({ iceServers: [stun] }, NOW)).toEqual({ iceServers: [stun], relayIssuedAt: NOW });
  });

  it("never lets older proven credentials replace newer proven ones", () => {
    const newer = { servers: [turnB], expiresAt: NOW + HOUR_MS, issuedAt: NOW };
    const older = { servers: [turnA], expiresAt: NOW + HOUR_MS, issuedAt: NOW - 60_000 };
    const servers: RuntimeIceServers = { stun: [stun], latestRelay: newer, provenRelay: newer };

    expect(noteRelayCarryingMedia(servers, older, NOW)).toBe(servers);
  });
});
