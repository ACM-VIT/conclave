export interface HostGrantInput {
  isWebinarAttendeeJoin: boolean;
  isForcedHost: boolean;
  scheduledRoomHostMatch: boolean;
  isScheduledHostRoom: boolean;
  requestedHost: boolean;
  bodyAllowRoomCreation: boolean;
  /** The page asking is creating a new meeting at this code (`body.createsMeeting`). */
  bodyCreatesMeeting: boolean;
  /** The join has a verified session email. */
  signedIn: boolean;
}

export interface HostGrant {
  isHost: boolean;
  allowRoomCreation: boolean;
  /** Whether the SFU records this join's account as the code's owner when it creates the code's first room. */
  createsCode: boolean;
}

export function resolveHostGrant(input: HostGrantInput): HostGrant {
  if (input.isWebinarAttendeeJoin) {
    return { isHost: false, allowRoomCreation: false, createsCode: false };
  }
  return {
    isHost: input.isForcedHost || input.scheduledRoomHostMatch,
    allowRoomCreation:
      !input.isScheduledHostRoom &&
      (input.requestedHost || input.bodyAllowRoomCreation),
    createsCode: !input.isScheduledHostRoom && input.signedIn && input.bodyCreatesMeeting,
  };
}
