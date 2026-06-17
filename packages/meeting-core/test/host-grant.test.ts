import { describe, it, expect } from "vitest";
import { resolveHostGrant, type HostGrantInput } from "../src/host-grant";

const base: HostGrantInput = {
  isWebinarAttendeeJoin: false,
  isForcedHost: false,
  scheduledRoomHostMatch: false,
  isScheduledHostRoom: false,
  requestedHost: false,
  bodyAllowRoomCreation: false,
};

describe("resolveHostGrant — privilege-escalation invariant", () => {
  it("a bare client host CLAIM never confers host (the fixed exploit)", () => {
    const g = resolveHostGrant({ ...base, requestedHost: true });
    expect(g.isHost).toBe(false);
    // ...but it does let them CREATE a new room → host via the SFU createdRoom path.
    expect(g.allowRoomCreation).toBe(true);
  });

  it("a host claim cannot create (and thus cannot host) a SCHEDULED room", () => {
    const g = resolveHostGrant({
      ...base,
      isScheduledHostRoom: true,
      requestedHost: true,
    });
    expect(g).toEqual({ isHost: false, allowRoomCreation: false });
  });

  it("grants host to a verified forced host (env allowlist)", () => {
    const g = resolveHostGrant({ ...base, isForcedHost: true });
    expect(g.isHost).toBe(true);
    // On its own allowRoomCreation is false — but the host token (isHost=true)
    // makes the SFU treat the join as hostRequested, which DOES let it create
    // the room server-side. With an explicit claim this flag is true too:
    expect(g.allowRoomCreation).toBe(false);
    expect(
      resolveHostGrant({ ...base, isForcedHost: true, requestedHost: true })
        .allowRoomCreation,
    ).toBe(true);
  });

  it("grants host on a verified scheduled-room host/co-host match", () => {
    const g = resolveHostGrant({
      ...base,
      isScheduledHostRoom: true,
      scheduledRoomHostMatch: true,
    });
    expect(g.isHost).toBe(true);
    // Scheduled rooms are never created by a join.
    expect(g.allowRoomCreation).toBe(false);
  });

  it("webinar attendees are never host and never create rooms — even with every claim set", () => {
    const g = resolveHostGrant({
      ...base,
      isWebinarAttendeeJoin: true,
      requestedHost: true,
      isForcedHost: true,
      scheduledRoomHostMatch: true,
      bodyAllowRoomCreation: true,
    });
    expect(g).toEqual({ isHost: false, allowRoomCreation: false });
  });

  it("honors an explicit allowRoomCreation body flag on a non-scheduled room", () => {
    const g = resolveHostGrant({ ...base, bodyAllowRoomCreation: true });
    expect(g.isHost).toBe(false);
    expect(g.allowRoomCreation).toBe(true);
  });

  it("a plain guest (no claim, no verification) gets nothing", () => {
    expect(resolveHostGrant({ ...base })).toEqual({
      isHost: false,
      allowRoomCreation: false,
    });
  });
});
