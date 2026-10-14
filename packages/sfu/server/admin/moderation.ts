import type { Client } from "../../config/classes/Client.js";
import type { Room } from "../../config/classes/Room.js";
import { getSocketAuthUser } from "../socket/auth.js";

export const SUPER_ADMIN_REMOVAL_ERROR = "Super admins cannot be removed";

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
