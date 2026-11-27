import jwt from "jsonwebtoken";
import type { OtherGuestSeat } from "@conclave/meeting-core/guest-join-claims";
import {
  parseRoomRecoveryPassClaims,
  ROOM_RECOVERY_PASS_USE,
  type RoomRecoveryPassClaims,
} from "@conclave/meeting-core/room-recovery-pass";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { Logger } from "../utilities/loggers.js";
import { holdsRoomLease } from "./roomLease.js";
import type { SfuState } from "./state.js";

const MAX_PASS_LENGTH = 2048;

// A pass lasts five minutes and the SFU renews it every minute. A pass that
// someone kept after a host removed them is therefore dead within five
// minutes. A member's pass has four minutes left when the SFU loses the room,
// or three if their last renewal went missing. That has to cover the restart
// (about 18 seconds until video is back), the web client's reconnect backoff
// (it retries 1, 3, 7, 15, 31, 63 and 127 seconds after the drop), and an
// instance recreating the room with a clock up to a minute ahead of the one
// that signed.
const TTL_SECONDS = 5 * 60;
const REFRESH_INTERVAL_MS = 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export const ROOM_RECOVERY_PASS_TTL_MS = TTL_SECONDS * 1000 + CLOCK_SKEW_MS;
// How long after the SFU last saw a room running a pass from it can still be
// good. Until then a recreated room is that call coming back, not a new one.
export const LOST_ROOM_WINDOW_MS =
  REFRESH_INTERVAL_MS + ROOM_RECOVERY_PASS_TTL_MS;

export type PassGeneration = { generation: number; until: number };

export const passesStillOut = (
  generations: readonly PassGeneration[],
  now: number = Date.now(),
): PassGeneration[] =>
  generations.filter(({ until }) => now <= until + ROOM_RECOVERY_PASS_TTL_MS);

const signedUnder = (
  generations: readonly PassGeneration[],
  claims: RoomRecoveryPassClaims,
): boolean =>
  generations.some(
    ({ generation, until }) =>
      claims.generation === generation && claims.issuedAtMs <= until + CLOCK_SKEW_MS,
  );

type RecoveryRoom = Pick<
  Room,
  "channelId" | "incarnationId" | "recoveryPassesVoidUntil" | "recoveryPassGenerations"
>;
type PassIssuingRoom = Pick<Room, "channelId" | "incarnationId" | "ownershipGeneration"> &
  Pick<Room, "userKeysById" | "needsReadmission" | "recordsItsCall">;
type PassHolder = Pick<Client, "id" | "isObserver">;

/**
 * Proof that `client` was let into this room, or null for someone a recreated
 * room should not take back unasked: a webinar attendee, a person a host
 * removed or took admission back from, on any of their devices, or anyone
 * once a host has ended the meeting. A room that
 * is recreated after the SFU lost it (a crash, a forced restart) has no
 * admission lists; this is how the people who were in the call get back in
 * without knocking. `tokenUse` keeps it from working as a join token.
 */
export const issueRoomRecoveryPass = (
  room: PassIssuingRoom,
  client: PassHolder,
  secret: string,
): string | null => {
  const userKey = room.userKeysById.get(client.id);
  if (
    !userKey ||
    client.isObserver ||
    !room.recordsItsCall ||
    room.needsReadmission(userKey)
  ) {
    return null;
  }
  return jwt.sign(
    {
      tokenUse: ROOM_RECOVERY_PASS_USE,
      channelId: room.channelId,
      userKey,
      incarnationId: room.incarnationId,
      // `iat` is in whole seconds. The end of a meeting is known to the
      // millisecond, and the two are compared.
      issuedAtMs: Date.now(),
      ...(typeof room.ownershipGeneration === "number" ? { generation: room.ownershipGeneration } : {}),
    },
    secret,
    { algorithm: "HS256", expiresIn: TTL_SECONDS },
  );
};

/**
 * Hands everyone in every room a new pass from time to time, so the one they
 * hold never runs out while they are in the call, and notes in the recovery
 * ledger that the room is still running. Returns how to stop.
 */
export const startRoomRecoveryPassRefresh = (
  state: Pick<SfuState, "rooms" | "roomRecovery" | "roomRegistry" | "deferredRoomWrites">,
  secret: string,
): (() => void) => {
  const timer = setInterval(() => {
    try {
      for (const room of state.rooms.values()) {
        if (!holdsRoomLease(state, room)) continue;
        if (room.recordsItsCall) state.roomRecovery.noteRunning(room);
        for (const client of room.clients.values()) {
          if (!client.socket.connected) continue;
          const roomRecoveryPass = issueRoomRecoveryPass(room, client, secret);
          if (!roomRecoveryPass) continue;
          client.socket.emit("roomRecoveryPass", {
            roomId: room.id,
            roomRecoveryPass,
          });
        }
      }
    } catch (error) {
      Logger.warn("Room recovery pass refresh failed", error);
    }
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};

const verifiedClaims = (pass: unknown, secret: string): RoomRecoveryPassClaims | null => {
  if (typeof pass !== "string" || !pass || pass.length > MAX_PASS_LENGTH) return null;
  try {
    return parseRoomRecoveryPassClaims(jwt.verify(pass, secret, { algorithms: ["HS256"] }));
  } catch {
    return null;
  }
};

export const isRecoveryPassFor = (
  pass: unknown,
  channelId: string,
  secret: string,
): boolean => verifiedClaims(pass, secret)?.channelId === channelId;

/**
 * Whether `pass` proves `userKey` was in an earlier incarnation of `room`.
 * A pass this incarnation issued proves nothing new: the live room already
 * knows who it admitted and who it removed. A pass from before a host ended
 * the meeting for everyone proves nothing either: that call is over.
 */
export const provesEarlierRoomMembership = (
  pass: unknown,
  room: RecoveryRoom,
  userKey: string,
  secret: string,
  formerSeats: readonly OtherGuestSeat[] = [],
): boolean => {
  const claims = verifiedClaims(pass, secret);
  return (
    claims !== null &&
    claims.channelId === room.channelId &&
    (claims.userKey === userKey || formerSeats.some((seat) => seat.userKey === claims.userKey)) &&
    claims.incarnationId !== room.incarnationId &&
    (room.recoveryPassesVoidUntil === null || claims.issuedAtMs > room.recoveryPassesVoidUntil) &&
    (room.recoveryPassGenerations === null || signedUnder(room.recoveryPassGenerations, claims))
  );
};
