import { describe, expect, it } from "vitest";
import {
  getReusableJoinInfo,
  holdJoinInfo,
  planJoinInfo,
  type JoinGrant,
} from "../src/app/lib/held-join-info";

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);

const tokenExpiringIn = (ms: number): string => {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ userId: "guest", exp: Math.floor((NOW + ms) / 1000) }),
    "signature",
  ].join(".");
};

const guest: JoinGrant = { joinMode: "meeting", userId: "guest", isHost: false };

type Answer = { token: string; sfuUrl: string; iceServersTtlSeconds?: number };

const held = ({
  joinInfo = { token: tokenExpiringIn(6 * 60 * 60_000), sfuUrl: "https://sfu" },
  grant = guest,
  receivedAt = NOW,
}: { joinInfo?: Answer; grant?: JoinGrant; receivedAt?: number } = {}) =>
  holdJoinInfo(joinInfo, { roomId: "room", grant, receivedAt });

const wanted = { roomId: "room", grant: guest, now: NOW };

describe("reusing the SFU token on reconnect", () => {
  it("reuses a token that is still valid for the same room and grant", () => {
    const current = held();

    expect(getReusableJoinInfo(current, wanted)).toBe(current.joinInfo);
  });

  it("asks for a new token when the held one is about to expire", () => {
    expect(
      getReusableJoinInfo(
        held({ joinInfo: { token: tokenExpiringIn(4 * 60_000), sfuUrl: "s" } }),
        wanted,
      ),
    ).toBeNull();
    expect(
      getReusableJoinInfo(
        held({ joinInfo: { token: tokenExpiringIn(-1_000), sfuUrl: "s" } }),
        wanted,
      ),
    ).toBeNull();
  });

  it("asks for a new answer once its TURN credentials are about to expire", () => {
    const joinInfo = {
      token: tokenExpiringIn(12 * 60 * 60_000),
      sfuUrl: "s",
      iceServersTtlSeconds: 60 * 60,
    };
    const answer = held({ joinInfo, receivedAt: NOW - 57 * 60_000 });

    expect(getReusableJoinInfo(answer, wanted)).toBeNull();
    expect(
      getReusableJoinInfo(answer, { ...wanted, now: NOW - 20 * 60_000 }),
    ).toBe(joinInfo);
  });

  it("goes by the token when the TURN credentials outlast it", () => {
    const joinInfo = {
      token: tokenExpiringIn(4 * 60_000),
      sfuUrl: "s",
      iceServersTtlSeconds: 24 * 60 * 60,
    };

    expect(getReusableJoinInfo(held({ joinInfo }), wanted)).toBeNull();
  });

  it("asks for a new token for another room, user or join mode", () => {
    expect(getReusableJoinInfo(held(), { ...wanted, roomId: "other" })).toBeNull();
    expect(
      getReusableJoinInfo(held(), {
        ...wanted,
        grant: { ...guest, userId: "someone-else" },
      }),
    ).toBeNull();
    expect(
      getReusableJoinInfo(held(), {
        ...wanted,
        grant: { ...guest, joinMode: "webinar_attendee" },
      }),
    ).toBeNull();
  });

  it("keeps a participant token for a participant who was made host", () => {
    const answer = held();

    expect(
      getReusableJoinInfo(answer, {
        ...wanted,
        grant: { ...guest, isHost: true },
      }),
    ).toBe(answer.joinInfo);
  });

  it("never reuses a host token for a participant", () => {
    expect(
      getReusableJoinInfo(held({ grant: { ...guest, isHost: true } }), wanted),
    ).toBeNull();
  });

  it("does not reuse a token whose expiry cannot be read", () => {
    for (const token of ["", "not-a-jwt", "a.b.c", "a.e30.c"]) {
      expect(
        getReusableJoinInfo(held({ joinInfo: { token, sfuUrl: "s" } }), wanted),
      ).toBeNull();
    }
  });

  it("holds nothing before the first join", () => {
    expect(getReusableJoinInfo(null, wanted)).toBeNull();
  });
});

describe("where a reconnect gets its join info", () => {
  it("goes straight to the SFU on the first attempt", () => {
    const current = held();

    expect(
      planJoinInfo({ held: current, ...wanted, isFirstReconnectAttempt: true }),
    ).toEqual({ source: "held", joinInfo: current.joinInfo });
  });

  it("asks the join route on later attempts and keeps the held token as a fallback", () => {
    const current = held();

    expect(
      planJoinInfo({ held: current, ...wanted, isFirstReconnectAttempt: false }),
    ).toEqual({ source: "fresh", fallback: current.joinInfo });
  });

  it("asks the join route with no fallback when nothing reusable is held", () => {
    expect(
      planJoinInfo({ held: null, ...wanted, isFirstReconnectAttempt: true }),
    ).toEqual({ source: "fresh", fallback: null });
  });
});
