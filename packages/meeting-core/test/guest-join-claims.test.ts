import { describe, expect, it } from "vitest";
import {
  issueRoomScopedClaims,
  issueSelfNamedGuestClaims,
  parseGuestJoinClaims,
  parseRoomScopedClaims,
  readJoinTokenSubject,
} from "../src/guest-join-claims";

const roomScoped = {
  userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA",
  guestProof: "proof-of-a-pass",
  guestRoom: "room",
  clientId: "conclave",
  sessionId: "tab-1",
};
const otherSeat = { userKey: "guest-gp_BBBBBBBBBBBBBBBBBBBBBB", guestProof: "proof-of-another-pass" };

describe("a guest join token issued from a pass", () => {
  it("parses to its room-scoped claims", () => {
    expect(parseGuestJoinClaims({ ...roomScoped, guestWas: [otherSeat] })).toEqual({
      scope: "room",
      ...roomScoped,
      guestWas: [otherSeat],
    });
  });

  it("parses with a former seat for every other pass the join route reads", () => {
    const guestWas = Array.from({ length: 15 }, () => otherSeat);

    expect(parseRoomScopedClaims({ ...roomScoped, guestWas })?.guestWas).toHaveLength(15);
  });

  it("parses beside the rest of a join token, which it leaves out", () => {
    const claims = parseGuestJoinClaims({ ...roomScoped, isHost: true, name: "Asha", iat: 1, exp: 2 });

    expect(claims).toEqual({ scope: "room", ...roomScoped });
  });

  it("drops a field no reader knows, at the top and inside a former seat", () => {
    const claims = parseGuestJoinClaims({
      ...roomScoped,
      grantsEverything: true,
      guestWas: [{ ...otherSeat, alsoHost: true }],
    });

    expect(claims).toEqual({ scope: "room", ...roomScoped, guestWas: [otherSeat] });
  });

  it.each([
    ["a user id of the wrong type", { ...roomScoped, userId: 7 }],
    ["a user id with another prefix", { ...roomScoped, userId: "guest-tab-1" }],
    ["an account's user id", { ...roomScoped, userId: "me@example.com" }],
    ["a seat key with a session suffix", { ...roomScoped, userId: "guest-gp_AAAA#tab-1" }],
    ["no proof", { ...roomScoped, guestProof: undefined }],
    ["a proof of the wrong type", { ...roomScoped, guestProof: { proof: "x" } }],
    ["an empty proof", { ...roomScoped, guestProof: "" }],
    ["a room of the wrong type", { ...roomScoped, guestRoom: 5 }],
    ["an empty room", { ...roomScoped, guestRoom: "" }],
    ["no client id", { ...roomScoped, clientId: undefined }],
    ["no session id", { ...roomScoped, sessionId: undefined }],
    ["a control character in the session id", { ...roomScoped, sessionId: "tab\u0000" }],
    ["one former seat that is not a list", { ...roomScoped, guestWas: otherSeat }],
    ["a former seat with another prefix", { ...roomScoped, guestWas: [{ ...otherSeat, userKey: "guest-tab-9" }] }],
    ["a former seat with no proof", { ...roomScoped, guestWas: [{ userKey: otherSeat.userKey }] }],
    ["more former seats than the join route ever names", { ...roomScoped, guestWas: Array.from({ length: 16 }, () => otherSeat) }],
  ])("is refused with %s", (_label, claims) => {
    expect(parseGuestJoinClaims(claims)).toBeNull();
    expect(parseRoomScopedClaims(claims)).toBeNull();
  });

  it("is refused when its room is missing or malformed, and is never read as a token for any room", () => {
    const { guestRoom: _room, ...noRoom } = roomScoped;

    expect(parseRoomScopedClaims(noRoom)).toBeNull();
    expect(parseGuestJoinClaims(noRoom)).toBeNull();
    expect(parseGuestJoinClaims({ ...noRoom, guestRoom: null })).toBeNull();
    expect(parseGuestJoinClaims({ userId: roomScoped.userId })).toBeNull();
  });

  it("cannot be issued in a shape a reader would refuse, and says which claim is at fault", () => {
    expect(issueRoomScopedClaims(roomScoped)).toEqual({ claims: roomScoped });
    expect(issueRoomScopedClaims({ ...roomScoped, userId: "guest-tab-1" })).toEqual({ invalid: "userId" });
    expect(issueRoomScopedClaims({ ...roomScoped, guestRoom: "" })).toEqual({ invalid: "guestRoom" });
    expect(issueRoomScopedClaims({ ...roomScoped, guestRoom: "r".repeat(257) })).toEqual({ invalid: "guestRoom" });
    expect(issueRoomScopedClaims({ ...roomScoped, clientId: "c".repeat(257) })).toEqual({ invalid: "clientId" });
  });
});

describe("a guest join token for a client that names itself", () => {
  it.each([
    ["with a proof", { userId: "guest-tab-1", guestProof: "proof-of-a-pass" }],
    ["with no proof", { userId: "guest-tab-1" }],
  ])("parses %s, and never as room-scoped", (_label, claims) => {
    expect(parseGuestJoinClaims({ ...claims, sessionId: "tab-1", clientId: "conclave" })).toEqual({
      scope: "none",
      guestProof: undefined,
      ...claims,
    });
    expect(parseRoomScopedClaims(claims)).toBeNull();
  });

  it("drops former seats, which only a room-scoped token can name", () => {
    expect(parseGuestJoinClaims({ userId: "guest-tab-1", guestWas: [otherSeat] })).toEqual({
      scope: "none",
      userId: "guest-tab-1",
      guestProof: undefined,
    });
  });

  it("cannot be issued under a seat key, which only a room-scoped token can name", () => {
    expect(issueSelfNamedGuestClaims({ userId: "guest-tab-1" })).toEqual({ claims: { userId: "guest-tab-1" } });
    expect(issueSelfNamedGuestClaims({ userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA" })).toEqual({ invalid: "userId" });
  });

  it.each([
    ["a user id that is not a guest's", { userId: "me@example.com" }],
    ["an issued seat key as its user id", { userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA", guestProof: "proof-of-a-pass" }],
    ["no user id", { guestProof: "proof-of-a-pass" }],
    ["a proof of the wrong type", { userId: "guest-tab-1", guestProof: 9 }],
  ])("is refused with %s", (_label, claims) => {
    expect(parseGuestJoinClaims(claims)).toBeNull();
  });

  it.each([null, undefined, "guest-tab-1", 4, []])("is refused when the claims are %j", (claims) => {
    expect(parseGuestJoinClaims(claims)).toBeNull();
  });
});

describe("the user key a join token names", () => {
  it.each([
    ["the account's email, lowercased", { email: " Me@Example.com ", userId: "u1" }, "me@example.com"],
    ["the user id when there is no email", { userId: " guest-gp_AAAA " }, "guest-gp_AAAA"],
    ["nothing for an empty token", {}, null],
    ["nothing for claims of the wrong type", { email: 5, userId: "u1" }, null],
    ["nothing for no claims", null, null],
  ])("is %s", (_label, claims, expected) => {
    expect(readJoinTokenSubject(claims)).toBe(expected);
  });
});
