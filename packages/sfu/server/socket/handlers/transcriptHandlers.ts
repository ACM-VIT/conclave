import jwt from "jsonwebtoken";
import { Admin } from "../../../config/classes/Admin.js";
import { config } from "../../../config/config.js";
import type {
  TranscriptTokenCapabilities,
  TranscriptTokenResponse,
} from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const TRANSCRIPT_TOKEN_TTL_SECONDS = 10 * 60;

const getTranscriptWorkerUrl = (): string =>
  (
    process.env.TRANSCRIPT_WORKER_URL ||
    process.env.NEXT_PUBLIC_TRANSCRIPT_WORKER_URL ||
    "http://localhost:8788"
  ).replace(/\/+$/, "");

const getTranscriptTokenSecret = (): string =>
  process.env.TRANSCRIPT_TOKEN_SECRET?.trim() || config.sfuSecret;

export const registerTranscriptHandlers = (
  context: ConnectionContext,
): void => {
  const { socket } = context;

  socket.on(
    "transcript:getToken",
    (
      callback: (response: TranscriptTokenResponse | { error: string }) => void,
    ) => {
      const room = context.currentRoom;
      const client = context.currentClient;
      if (!room || !client || !context.currentUserKey) {
        respond(callback, { error: "Not in a room" });
        return;
      }

      if (client.isObserver) {
        respond(callback, {
          error: "Transcript is available to meeting participants only",
        });
        return;
      }

      if (!takeToken(socket, "transcript:token", RATE_LIMITS.transcriptToken)) {
        respond(callback, {
          error: "Too many transcript token requests; please retry shortly",
        });
        return;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiresAt = (nowSeconds + TRANSCRIPT_TOKEN_TTL_SECONDS) * 1000;
      const isAdmin = client instanceof Admin;
      const isHost = room.getHostUserId() === client.id;
      const capabilities: TranscriptTokenCapabilities = {
        start: true,
        takeover: true,
        stop: isAdmin || isHost,
        ask: true,
      };
      const displayName = room.getDisplayNameForUser(client.id) || client.id;
      const payload = {
        iss: "conclave-sfu",
        aud: "conclave-transcript-worker",
        sub: client.id,
        userId: client.id,
        displayName,
        roomId: room.id,
        clientId: room.clientId,
        channelId: room.channelId,
        isAdmin,
        isHost,
        capabilities,
      };

      const token = jwt.sign(payload, getTranscriptTokenSecret(), {
        algorithm: "HS256",
        expiresIn: TRANSCRIPT_TOKEN_TTL_SECONDS,
      });

      respond(callback, {
        roomId: room.id,
        workerUrl: getTranscriptWorkerUrl(),
        token,
        expiresAt,
        capabilities,
      });
    },
  );
};
