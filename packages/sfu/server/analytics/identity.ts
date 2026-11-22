import { createHmac } from "crypto";
import { config as sfuConfig } from "../../config/config.js";

const keyedHash = (value: string): string =>
  createHmac("sha256", sfuConfig.sfuSecret).update(value).digest("hex").slice(0, 32);

export const analyticsDistinctId = (stableIdentity: string): string =>
  `user_${keyedHash(stableIdentity)}`;

/**
 * The PostHog group key for a room. A room code lets anyone join, so the key
 * is a keyed hash: events still roll up per room, but the code cannot be read
 * back or guessed without SFU_SECRET.
 */
export const analyticsRoomKey = (roomChannelId: string): string =>
  `room_${keyedHash(`room:${roomChannelId}`)}`;
