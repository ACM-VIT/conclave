export interface HostGrantInput {
  isWebinarAttendeeJoin: boolean;
  isForcedHost: boolean;
  scheduledRoomHostMatch: boolean;
  isScheduledHostRoom: boolean;
  requestedHost: boolean;
  bodyAllowRoomCreation: boolean;
}

export interface HostGrant {
  isHost: boolean;
  allowRoomCreation: boolean;
}

export function resolveHostGrant(input: HostGrantInput): HostGrant {
  if (input.isWebinarAttendeeJoin) {
    return { isHost: false, allowRoomCreation: false };
  }
  return {
    isHost: input.isForcedHost || input.scheduledRoomHostMatch,
    allowRoomCreation:
      !input.isScheduledHostRoom &&
      (input.requestedHost || input.bodyAllowRoomCreation),
  };
}
