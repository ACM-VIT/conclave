/**
 * Pure decision for whether an SFU join request confers HOST authority and/or
 * the ability to CREATE a room. Extracted from the web `/api/sfu/join` route so
 * the security invariant below is unit-testable and can never silently regress.
 *
 * THE INVARIANT (a fixed privilege-escalation hole): a bare client
 * `isHost`/`isAdmin` claim (`requestedHost`) MUST NEVER, by itself, make someone
 * host. Host is granted only via a verified session — the env always-host
 * allowlist (`isForcedHost`) or a scheduled-room host/co-host match
 * (`scheduledRoomHostMatch`). A claim only grants the ability to CREATE a
 * not-yet-existing room, so the creator becomes host through the SFU's
 * server-authoritative `createdRoom` path and can never seize an EXISTING room.
 */
export interface HostGrantInput {
  /** Joining a webinar as an attendee — never host, never creates rooms. */
  isWebinarAttendeeJoin: boolean;
  /** Session email is in the env always-host allowlist (server-verified). */
  isForcedHost: boolean;
  /** Scheduled room AND the session email matches its host/co-host (verified). */
  scheduledRoomHostMatch: boolean;
  /** The room id is a scheduled (`sched-…`) room. */
  isScheduledHostRoom: boolean;
  /** The CLIENT asked to host (body.isHost/isAdmin). NEVER trusted for host. */
  requestedHost: boolean;
  /** Explicit `body.allowRoomCreation` intent. */
  bodyAllowRoomCreation: boolean;
  /** The page asking is creating a new meeting at this code (`body.createsMeeting`). */
  bodyCreatesMeeting: boolean;
  /** The join has a verified session email. */
  signedIn: boolean;
}

export interface HostGrant {
  /** Whether to mint a host/admin token — verified paths only. */
  isHost: boolean;
  /** Whether the SFU may create the room for this join (creator → host). */
  allowRoomCreation: boolean;
  /** Whether the SFU records this join's account as the code's owner when it creates the code's first room. */
  createsCode: boolean;
}

export function resolveHostGrant(input: HostGrantInput): HostGrant {
  if (input.isWebinarAttendeeJoin) {
    return { isHost: false, allowRoomCreation: false, createsCode: false };
  }
  return {
    // Verified paths only. `requestedHost` is deliberately absent here.
    isHost: input.isForcedHost || input.scheduledRoomHostMatch,
    // A host claim (or explicit flag) only confers room-CREATION on a
    // non-scheduled room; the SFU's createdRoom path makes the creator host.
    allowRoomCreation:
      !input.isScheduledHostRoom &&
      (input.requestedHost || input.bodyAllowRoomCreation),
    createsCode: !input.isScheduledHostRoom && input.signedIn && input.bodyCreatesMeeting,
  };
}
