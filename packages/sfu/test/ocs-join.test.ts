import { describe, expect, it } from "vitest";
import { authorizedOcsSfuJoin } from "../server/ocsJoin.js";

const roomId = "ocs27-interview-001";
const user = {
  clientId: "ocs27",
  userId: "ocs27:ghost:profile-1",
  ocs: { roomId, bookingId: "booking-1", profileId: "profile-1", role: "ghost" as const },
};

describe("OCS SFU join boundary", () => {
  it("rejects a leaked room ID and role or identity mismatch", () => {
    expect(authorizedOcsSfuJoin(roomId, undefined)).toBe(false);
    expect(authorizedOcsSfuJoin(roomId, user)).toBe(true);
    expect(authorizedOcsSfuJoin(roomId, { ...user, ocs: { ...user.ocs, role: "candidate" as const } })).toBe(false);
    expect(authorizedOcsSfuJoin(roomId, { ...user, clientId: "conclave" })).toBe(false);
    expect(authorizedOcsSfuJoin(roomId, { ...user, isSuperAdmin: true })).toBe(false);
    expect(authorizedOcsSfuJoin("ocs27-other-room", user)).toBe(false);
  });

  it("leaves ordinary Conclave rooms alone", () => {
    expect(authorizedOcsSfuJoin("ordinary-room", undefined)).toBe(true);
    expect(authorizedOcsSfuJoin("ordinary-room", user)).toBe(false);
  });
});
