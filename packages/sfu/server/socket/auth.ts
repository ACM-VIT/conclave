import jwt, { type JwtPayload, type VerifyErrors } from "jsonwebtoken";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { config as defaultConfig } from "../../config/config.js";

/**
 * Claims minted by the web join route (apps/web api/sfu/join) when it signs
 * the SFU token. All optional: older tokens and other clients may omit any of
 * them, so consumers must handle absence.
 */
export type SfuAuthPayload = JwtPayload & {
  clientId?: string;
  joinMode?: string;
  email?: string;
  userId?: string;
  name?: string;
  sessionId?: string;
  /**
   * Keyed hash of the guest pass behind a guest `userId`. Never sent to other
   * participants, so holding a guest's public id is not enough to rejoin as
   * that guest. Absent on signed-in tokens and on guests from clients that
   * predate guest passes.
   */
  guestProof?: string;
  /**
   * The room id a guest's seat key was issued for. A token that carries it
   * joins that room and no other. Absent on signed-in tokens and on guests
   * from clients that predate guest passes.
   */
  guestRoom?: string;
  /**
   * The seat this guest held before the browser's pass changed, with that
   * seat's proof. The join route adds it when a tab comes back under another
   * pass and still has the token of its previous join. What the old key
   * holds in the room moves to the new key.
   */
  guestWas?: { userKey?: string; guestProof?: string };
  isHost?: boolean;
  isAdmin?: boolean;
  isForcedHost?: boolean;
  isSuperAdmin?: boolean;
  allowRoomCreation?: boolean;
};

const isSfuAuthPayload = (
  decoded: string | JwtPayload | undefined,
): decoded is SfuAuthPayload =>
  Boolean(decoded && typeof decoded === "object");

/**
 * Other tokens signed with the same secret: the SFU's own assistant and
 * room-AI tokens (`tokenUse`, `aud`, `iss`), chat image upload tokens
 * (`type`) and, when TRANSCRIPT_TOKEN_SECRET falls back to the SFU secret,
 * transcript tokens (`aud`, `iss`). Several carry `isAdmin`/`isHost` or a
 * session-only user id, so accepting them as a login let a room creator
 * mint host claims for other rooms (including scheduled webinars) and let a
 * blocked user rejoin under an identity the block list does not match. Join
 * tokens from the web route carry none of these claims.
 */
export const isNonJoinToken = (decoded: JwtPayload): boolean =>
  decoded.aud !== undefined ||
  decoded.iss !== undefined ||
  (decoded as { tokenUse?: unknown }).tokenUse !== undefined ||
  (decoded as { type?: unknown }).type !== undefined;

// socket.io types `socket.data` as `any`; this pair is the single asserted
// view of the auth slot. The middleware below is the only writer.
type SocketAuthData = { user?: SfuAuthPayload };

export const getSocketAuthUser = (
  socket: Socket,
): SfuAuthPayload | undefined => (socket.data as SocketAuthData).user;

const setSocketAuthUser = (socket: Socket, user: SfuAuthPayload): void => {
  (socket.data as SocketAuthData).user = user;
};

export const attachSocketAuth = (
  io: SocketIOServer,
  options?: { config?: typeof defaultConfig },
): void => {
  const config = options?.config ?? defaultConfig;

  io.use((socket, next) => {
    const token =
      typeof socket.handshake.auth.token === "string"
        ? socket.handshake.auth.token
        : null;
    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    jwt.verify(
      token,
      config.sfuSecret,
      { algorithms: ["HS256"] },
      (err: VerifyErrors | null, decoded: string | JwtPayload | undefined) => {
        if (err) {
          return next(new Error("Authentication error: Invalid token"));
        }

        if (!isSfuAuthPayload(decoded) || isNonJoinToken(decoded)) {
          return next(new Error("Authentication error: Invalid token payload"));
        }

        setSocketAuthUser(socket, decoded);
        next();
      },
    );
  });
};
