import { describe, expect, it } from "vitest";
import {
  NO_RUNTIME_ICE_SERVERS,
  applyJoinAnswerToIceServers,
  type RuntimeIceServers,
} from "../src/app/lib/relay-credentials";

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const HOUR_MS = 60 * 60_000;
const stun = { urls: "stun:stun.example:3478" };
const turnA = { urls: "turn:turn.example:3478", username: "a", credential: "a" };
const turnB = { urls: "turns:turn.example:5349", username: "b", credential: "b" };

const holding = (turnExpiresAt: number | null): RuntimeIceServers => ({
  stun: [stun],
  turn: [turnA],
  turnExpiresAt,
});

describe("ICE servers after a join answer", () => {
  it("takes the answer's TURN credentials and their lifetime", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(NOW + HOUR_MS),
        { iceServers: [stun, turnB], relayExpiresAt: NOW + 2 * HOUR_MS },
        NOW,
      ),
    ).toEqual({ stun: [stun], turn: [turnB], turnExpiresAt: NOW + 2 * HOUR_MS });
  });

  it("keeps unexpired TURN credentials when an answer brings no relay", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(NOW + HOUR_MS),
        { iceServers: [stun], relayExpiresAt: null },
        NOW,
      ),
    ).toEqual({ stun: [stun], turn: [turnA], turnExpiresAt: NOW + HOUR_MS });
  });

  it("keeps TURN credentials with no known lifetime when an answer brings no relay", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(null),
        { iceServers: [stun], relayExpiresAt: null },
        NOW,
      ).turn,
    ).toEqual([turnA]);
  });

  it("drops expired TURN credentials when an answer brings no relay", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(NOW + 2_000),
        { iceServers: [stun], relayExpiresAt: null },
        NOW,
      ),
    ).toEqual({ stun: [stun], turn: null, turnExpiresAt: null });
  });

  it("uses a fresh answer's short-lived TURN credentials", () => {
    expect(
      applyJoinAnswerToIceServers(
        NO_RUNTIME_ICE_SERVERS,
        { iceServers: [stun, turnB], relayExpiresAt: NOW + 60_000 },
        NOW,
      ).turn,
    ).toEqual([turnB]);
  });

  it("keeps held TURN credentials with under a minute left over an answer without a relay", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(NOW + 45_000),
        { iceServers: [stun], relayExpiresAt: null },
        NOW,
      ).turn,
    ).toEqual([turnA]);
  });

  it("ignores an answer's TURN credentials that have already expired", () => {
    expect(
      applyJoinAnswerToIceServers(
        NO_RUNTIME_ICE_SERVERS,
        { iceServers: [stun, turnB], relayExpiresAt: NOW - 1_000 },
        NOW,
      ),
    ).toEqual({ stun: [stun], turn: null, turnExpiresAt: null });
  });

  it("keeps the current relay over an answer whose own relay has expired", () => {
    expect(
      applyJoinAnswerToIceServers(
        holding(NOW + HOUR_MS),
        { iceServers: [stun, turnB], relayExpiresAt: NOW - 1_000 },
        NOW,
      ).turn,
    ).toEqual([turnA]);
  });
});
