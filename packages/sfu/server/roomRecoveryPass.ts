import jwt from "jsonwebtoken";
import type { Room } from "../config/classes/Room.js";

const TOKEN_USE = "room-recovery";
// A call can run this long between reconnects, the life of a join token.
const TTL_SECONDS = 12 * 60 * 60;
const MAX_PASS_LENGTH = 2048;

type RecoveryRoom = Pick<Room, "channelId" | "incarnationId">;

/**
 * Proof that `userKey` was let into this room, handed to them when they join.
 * A room that is recreated after the SFU lost it (a crash, a forced restart)
 * has no admission lists; this is how the people who were in the call get
 * back in without knocking. `tokenUse` keeps it from working as a join token.
 */
export const issueRoomRecoveryPass = (
  room: RecoveryRoom,
  userKey: string,
  secret: string,
): string =>
  jwt.sign(
    {
      tokenUse: TOKEN_USE,
      channelId: room.channelId,
      userKey,
      incarnationId: room.incarnationId,
    },
    secret,
    { algorithm: "HS256", expiresIn: TTL_SECONDS },
  );

/**
 * Whether `pass` proves `userKey` was in an earlier incarnation of `room`.
 * A pass this incarnation issued proves nothing new: the live room already
 * knows who it admitted and who it removed.
 */
export const provesEarlierRoomMembership = (
  pass: unknown,
  room: RecoveryRoom,
  userKey: string,
  secret: string,
): boolean => {
  if (typeof pass !== "string" || !pass || pass.length > MAX_PASS_LENGTH) {
    return false;
  }
  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(pass, secret, { algorithms: ["HS256"] });
  } catch {
    return false;
  }
  return (
    typeof claims === "object" &&
    claims.tokenUse === TOKEN_USE &&
    claims.channelId === room.channelId &&
    claims.userKey === userKey &&
    typeof claims.incarnationId === "string" &&
    claims.incarnationId !== room.incarnationId
  );
};
