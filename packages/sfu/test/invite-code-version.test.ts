import { describe, expect, it } from "vitest";
import type { Router } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import {
  getOrCreateWebinarRoomConfig,
  toWebinarConfigSnapshot,
  updateWebinarRoomConfig,
} from "../server/webinar.js";

describe("invite code version", () => {
  it("changes with the meeting code and never exposes the code", () => {
    const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router: {} as Router });
    expect(room.meetingInviteCodeVersion).toBe("");
    room.setMeetingInviteCode("ROOM42");
    const first = room.meetingInviteCodeVersion;
    room.setMeetingInviteCode("ROOM42");
    expect(room.meetingInviteCodeVersion).toBe(first);
    room.setMeetingInviteCode("NEXT77");
    expect(room.meetingInviteCodeVersion).not.toBe(first);
    expect(room.meetingInviteCodeVersion).not.toContain("NEXT77");
    room.setMeetingInviteCode(null);
    expect(room.meetingInviteCodeVersion).toBe("");
  });

  it("gives the same code a different version in every room", () => {
    const rooms = ["a", "b"].map(
      (id) => new Room({ id, clientId: "conclave", workerPid: null, router: {} as Router }),
    );
    rooms.forEach((room) => room.setMeetingInviteCode("ROOM42"));
    const webinar = getOrCreateWebinarRoomConfig(new Map(), "conclave:a");
    updateWebinarRoomConfig(webinar, { inviteCode: "ROOM42" });
    const versions = new Set([
      ...rooms.map((room) => room.meetingInviteCodeVersion),
      toWebinarConfigSnapshot(webinar, 0).inviteCodeVersion,
    ]);
    expect(versions.size).toBe(3);
  });

  it("changes with the webinar code but not with other webinar settings", () => {
    const config = getOrCreateWebinarRoomConfig(new Map(), "conclave:room");
    updateWebinarRoomConfig(config, { enabled: true, inviteCode: "WATCH7" });
    const first = toWebinarConfigSnapshot(config, 0).inviteCodeVersion;
    expect(first).not.toBe("");
    updateWebinarRoomConfig(config, { locked: true, maxAttendees: 40 });
    expect(toWebinarConfigSnapshot(config, 3).inviteCodeVersion).toBe(first);
    updateWebinarRoomConfig(config, { inviteCode: "WATCH8" });
    expect(toWebinarConfigSnapshot(config, 3).inviteCodeVersion).not.toBe(first);
  });
});
