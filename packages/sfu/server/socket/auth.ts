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
  canGhostJoin?: boolean;
  email?: string;
  userId?: string;
  name?: string;
  sessionId?: string;
  isHost?: boolean;
  isAdmin?: boolean;
  isForcedHost?: boolean;
  allowRoomCreation?: boolean;
};

const isSfuAuthPayload = (
  decoded: string | JwtPayload | undefined,
): decoded is SfuAuthPayload =>
  Boolean(decoded && typeof decoded === "object");

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
      (err: VerifyErrors | null, decoded: string | JwtPayload | undefined) => {
        if (err) {
          return next(new Error("Authentication error: Invalid token"));
        }

        if (!isSfuAuthPayload(decoded)) {
          return next(new Error("Authentication error: Invalid token payload"));
        }

        setSocketAuthUser(socket, decoded);
        next();
      },
    );
  });
};
