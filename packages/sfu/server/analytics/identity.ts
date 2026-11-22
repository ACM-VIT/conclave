import { createHmac, randomBytes } from "crypto";
import { analyticsSettings } from "./settings.js";

// Without a real SFU_SECRET the fallback key is public, and anyone could hash a
// guessed email or room code and compare. Distinct ids then use a key that
// lives only in this process, and rooms are not grouped at all.
export const analyticsKey: string | Uint8Array = analyticsSettings.secret ?? randomBytes(32);

const keyedHash = (value: string): string =>
  createHmac("sha256", analyticsKey).update(value).digest("hex").slice(0, 32);

export const analyticsDistinctId = (stableIdentity: string): string =>
  `user_${keyedHash(stableIdentity)}`;

/**
 * The PostHog group key for a room, or null when SFU_SECRET is not set. A room
 * code lets anyone join, so the key is a keyed hash: events still roll up per
 * room, but the code cannot be read back or guessed without the secret.
 */
export const analyticsRoomKey = (roomChannelId: string): string | null =>
  analyticsSettings.secret ? `room_${keyedHash(`room:${roomChannelId}`)}` : null;
