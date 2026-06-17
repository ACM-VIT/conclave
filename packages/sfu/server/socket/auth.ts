import jwt, { type JwtPayload, type VerifyErrors } from "jsonwebtoken";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../../config/config.js";

type SfuAuthPayload = JwtPayload & {
  clientId?: string;
  joinMode?: string;
};

const isSfuAuthPayload = (
  decoded: string | JwtPayload | undefined,
): decoded is SfuAuthPayload =>
  Boolean(decoded && typeof decoded === "object");

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

        socket.data.user = decoded;
        next();
      },
    );
  });
};
