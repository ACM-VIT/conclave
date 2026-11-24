import type { Room } from "../../config/classes/Room.js";

export const HOST_ONLY_EVENTS = [
  "pendingUsersSnapshot",
  "userRequestedJoin",
  "userAdmitted",
  "userRejected",
  "pendingUserLeft",
  "admin:roomStateChanged",
  "webinar:handQueueChanged",
] as const;

export type HostOnlyEvent = (typeof HOST_ONLY_EVENTS)[number];

export const emitToHosts = (
  room: Room,
  event: HostOnlyEvent,
  payload: unknown,
): void => {
  for (const admin of room.getAdmins()) {
    if (room.isAdminClient(admin)) {
      admin.socket.emit(event, payload);
    }
  }
};
