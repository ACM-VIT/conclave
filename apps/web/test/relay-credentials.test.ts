import { describe, expect, it } from "vitest";
import {
  NO_RUNTIME_ICE_SERVERS,
  applyJoinAnswerToIceServers,
  getUsableTurnIceServers,
  noteRelayCarryingMedia,
  readSelectedRelayUrl,
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
  const relayA = { urls: "turn:127.0.0.1:30603?transport=udp", username: "a", credential: "a" };
  const relayB = { urls: "turn:127.0.0.1:30606?transport=udp", username: "b", credential: "b" };
  const provenA: RuntimeIceServers = {
    stun: [stun],
    latestRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS },
    provenRelay: { servers: [relayA], expiresAt: NOW + HOUR_MS },
  };

  it("is still offered when a new answer brings another relay", () => {
    const next = applyJoinAnswerToIceServers(
      provenA,
      { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS },
      NOW,
    );

    expect(getUsableTurnIceServers(next, NOW)).toEqual([relayB, relayA]);
  });

  it("stays offered while transports keep connecting through it", () => {
    const next = noteRelayCarryingMedia(
      applyJoinAnswerToIceServers(
        provenA,
        { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS },
        NOW,
      ),
      "turn:127.0.0.1:30603?transport=udp",
    );

    expect(getUsableTurnIceServers(next, NOW)).toEqual([relayB, relayA]);
  });

  it("is dropped once the new relay has carried media", () => {
    const next = noteRelayCarryingMedia(
      applyJoinAnswerToIceServers(
        provenA,
        { iceServers: [stun, relayB], relayExpiresAt: NOW + HOUR_MS },
        NOW,
      ),
      "turn:127.0.0.1:30606?transport=udp",
    );

    expect(getUsableTurnIceServers(next, NOW)).toEqual([relayB]);
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

describe("reading which relay a transport uses", () => {
  const stats = (pairLocal: string, local: Record<string, unknown>) => [
    { type: "transport", id: "T", selectedCandidatePairId: "P" },
    { type: "candidate-pair", id: "P", localCandidateId: pairLocal, state: "succeeded" },
    { type: "local-candidate", id: "L1", ...local },
  ];

  it("returns the TURN URL of the selected relay candidate", () => {
    expect(
      readSelectedRelayUrl(
        stats("L1", { candidateType: "relay", url: "turn:127.0.0.1:30603?transport=udp" }),
      ),
    ).toBe("turn:127.0.0.1:30603?transport=udp");
  });

  it("returns nothing for a direct path", () => {
    expect(readSelectedRelayUrl(stats("L1", { candidateType: "host" }))).toBeNull();
  });

  it("falls back to the nominated pair when the transport does not name one", () => {
    expect(
      readSelectedRelayUrl([
        { type: "candidate-pair", id: "P", localCandidateId: "L1", nominated: true, state: "succeeded" },
        { type: "local-candidate", id: "L1", candidateType: "relay", url: "turns:turn.example:5349" },
      ]),
    ).toBe("turns:turn.example:5349");
  });
});
