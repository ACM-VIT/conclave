import { canonicalizeClientId } from "../../../../packages/sfu/server/clientIds.js";
import type { ScheduledMeetingStore } from "../../../../packages/sfu/server/scheduledMeetings.js";
import type { ScheduledMeeting } from "../../../../packages/sfu/types.js";

const roomCodeKey = (clientId: string, roomCode: string): string =>
  `${clientId}:${roomCode}`;

const isActiveMeeting = (meeting: ScheduledMeeting): boolean =>
  meeting.status === "scheduled" || meeting.status === "live";

const claimRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  const ownerId = store.byRoomCode.get(key);
  const owner = ownerId ? store.byId.get(ownerId) : undefined;
  if (
    owner &&
    owner.id !== meeting.id &&
    isActiveMeeting(owner) &&
    !isActiveMeeting(meeting)
  ) {
    return;
  }
  store.byRoomCode.set(key, meeting.id);
};

const releaseRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  if (store.byRoomCode.get(key) === meeting.id) {
    store.byRoomCode.delete(key);
  }
};

const isCodeTaken = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
  excludeId?: string,
): boolean => {
  const owner = store.byRoomCode.get(roomCodeKey(clientId, roomCode));
  if (!owner) return false;
  if (excludeId && owner === excludeId) return false;
  const existing = store.byId.get(owner);
  if (!existing) return false;
  return existing.status === "scheduled" || existing.status === "live";
};

export const moveScheduledMeetingToClient = (
  store: ScheduledMeetingStore,
  meetingId: string,
  clientId: string,
): ScheduledMeeting | null => {
  const meeting = store.byId.get(meetingId);
  const nextClientId = canonicalizeClientId(clientId);
  if (!meeting || !nextClientId || meeting.clientId === nextClientId) {
    return meeting ?? null;
  }
  if (isCodeTaken(store, nextClientId, meeting.roomCode, meeting.id)) {
    throw new Error("That meeting code already exists in the target client.");
  }
  releaseRoomCode(store, meeting);
  meeting.clientId = nextClientId;
  meeting.updatedAt = Date.now();
  claimRoomCode(store, meeting);
  return meeting;
};
