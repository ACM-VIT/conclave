import type { Client } from "../../config/classes/Client.js";
import type { Room } from "../../config/classes/Room.js";
import { getSocketAuthUser } from "../socket/auth.js";

export const SUPER_ADMIN_REMOVAL_ERROR = "Super admins cannot be removed";
export const NO_ONE_ADMITTED_ERROR =
  "No one was let in. A guest who is not in the meeting has to ask to join first.";

// A host's admission or stage invite that the room's decision record could
// not keep, because it holds only refusals. Nothing changed.
export const DECISION_RECORD_FULL = "DECISION_RECORD_FULL";
export const decisionRecordFull = (action: "admit" | "invite") => ({
  success: false as const,
  code: DECISION_RECORD_FULL,
  error:
    action === "invite"
      ? "Couldn't invite: this meeting has reached its limit of host decisions."
      : "Couldn't admit: this meeting has reached its limit of host decisions.",
});

export const isSuperAdminClient = (client: Client | undefined): boolean => {
  if (!client) return false;
  const user = getSocketAuthUser(client.socket);
  // Older join tokens identify the verified email allowlist via isForcedHost.
  // Room creation and host promotion must never confer this protection.
  return user?.isSuperAdmin === true || user?.isForcedHost === true;
};

export const includesSuperAdminUserKey = (
  room: Room,
  userKeys: string[],
): boolean => {
  const keys = new Set(userKeys);
  for (const client of room.clients.values()) {
    const userKey = room.userKeysById.get(client.id);
    if (userKey && keys.has(userKey) && isSuperAdminClient(client)) {
      return true;
    }
  }
  return false;
};
