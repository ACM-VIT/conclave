import type { Admin } from "../../config/classes/Admin.js";
import type { Room } from "../../config/classes/Room.js";

export const HOST_ONLY_EVENTS = [
  "pendingUsersSnapshot",
  "userRequestedJoin",
  "userAdmitted",
  "userRejected",
  "pendingUserLeft",
  "admin:roomStateChanged",
  "webinar:handQueueChanged",
  "webinar:stageInviteUsed",
] as const;

export type HostOnlyEvent = (typeof HOST_ONLY_EVENTS)[number];

export const emitToHost = (
  host: Admin,
  event: HostOnlyEvent,
  payload: unknown,
): void => {
  if (!host.isObserver) {
    host.socket.emit(event, payload);
  }
};

export const emitToHosts = (
  room: Room,
  event: HostOnlyEvent,
  payload: unknown,
): void => {
  for (const admin of room.getAdmins()) {
    emitToHost(admin, event, payload);
  }
};
