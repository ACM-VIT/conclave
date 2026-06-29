import jwt from "jsonwebtoken";
import { Admin } from "../../../config/classes/Admin.js";
import { config } from "../../../config/config.js";
import type {
  TranscriptSfuRelayStartRequest,
  TranscriptSfuRelayStartResponse,
  TranscriptSfuRelayStatusResponse,
  TranscriptSfuRelayStopResponse,
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

type RelayStartTokenPayload = jwt.JwtPayload & {
  tokenUse?: string;
  userId?: string;
  roomId?: string;
  clientId?: string;
  channelId?: string;
  sessionStatus?: string;
  transportMode?: string;
};

export const verifyTranscriptRelayStartToken = (
  token: string | undefined,
  room: { id: string; clientId: string; channelId: string },
  userId: string,
): { ok: true } | { ok: false; message: string } => {
  if (!token || typeof token !== "string") {
    return { ok: false, message: "Transcript worker relay authorization is required." };
  }
  try {
    const payload = jwt.verify(token, getTranscriptTokenSecret(), {
      algorithms: ["HS256"],
      audience: "conclave-sfu",
      issuer: "conclave-transcript-worker",
    }) as RelayStartTokenPayload;
    if (
      payload.tokenUse !== "transcript:sfuRelayStart" ||
      payload.userId !== userId ||
      payload.roomId !== room.id ||
      payload.clientId !== room.clientId ||
      payload.channelId !== room.channelId ||
      payload.sessionStatus !== "live" ||
      payload.transportMode !== "sfu"
    ) {
      return { ok: false, message: "Transcript worker relay authorization does not match this room." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Transcript worker relay authorization is invalid or expired." };
  }
};

const createTranscriptRelayToken = (options: {
  roomId: string;
  clientId: string;
  channelId: string;
  displayName: string;
}): string => {
  const capabilities: TranscriptTokenCapabilities = {
    start: false,
    takeover: false,
    stop: false,
    ask: false,
    relayAudio: true,
  };
  return jwt.sign(
    {
      iss: "conclave-sfu",
      aud: "conclave-transcript-worker",
      sub: `sfu:${options.roomId}`,
      userId: `sfu:${options.roomId}`,
      displayName: "Conclave SFU Relay",
      roomId: options.roomId,
      clientId: options.clientId,
      channelId: options.channelId,
      isAdmin: false,
      isHost: false,
      isGhost: false,
      capabilities,
      relayFor: options.displayName,
    },
    getTranscriptTokenSecret(),
    {
      algorithm: "HS256",
      expiresIn: TRANSCRIPT_TOKEN_TTL_SECONDS,
    },
  );
};

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

      if (client.isWebinarAttendee) {
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
      const isAdmin = client instanceof Admin && !client.isObserver;
      const isHost = room.getHostUserId() === client.id;
      const isGhost = client.isGhost;
      const capabilities: TranscriptTokenCapabilities = {
        start: !isGhost,
        takeover: !isGhost,
        stop: !isGhost && (isAdmin || isHost),
        ask: !isGhost,
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
        isGhost,
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

  socket.on(
    "transcript:sfuRelayStatus",
    (
      callback: (
        response: TranscriptSfuRelayStatusResponse | { error: string },
      ) => void,
    ) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      respond(callback, context.state.transcriptRelays.getStatus());
    },
  );

  socket.on(
    "transcript:sfuRelayStart",
    async (
      requestOrCallback:
        | TranscriptSfuRelayStartRequest
        | ((
            response: TranscriptSfuRelayStartResponse | { error: string },
          ) => void),
      maybeCallback?: (
        response: TranscriptSfuRelayStartResponse | { error: string },
      ) => void,
    ) => {
      const callback =
        typeof requestOrCallback === "function"
          ? requestOrCallback
          : maybeCallback;
      const request =
        typeof requestOrCallback === "function" ? null : requestOrCallback;
      if (!callback) return;
      const room = context.currentRoom;
      const client = context.currentClient;
      if (!room || !client || !context.currentUserKey) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (client.isGhost || client.isWebinarAttendee) {
        respond(callback, {
          error: "Transcript relay is available to meeting participants only",
        });
        return;
      }
      if (!takeToken(socket, "transcript:relay", RATE_LIMITS.transcriptRelay)) {
        respond(callback, {
          error: "Too many transcript relay requests; please retry shortly",
        });
        return;
      }
      const relayAuthorization = verifyTranscriptRelayStartToken(
        request?.relayStartToken,
        room,
        client.id,
      );
      if (!relayAuthorization.ok) {
        respond(callback, { error: relayAuthorization.message });
        return;
      }

      const displayName = room.getDisplayNameForUser(client.id) || client.id;
      const isAdmin = client instanceof Admin && !client.isObserver;
      const isHost = room.getHostUserId() === client.id;
      const workerToken = createTranscriptRelayToken({
        roomId: room.id,
        clientId: room.clientId,
        channelId: room.channelId,
        displayName,
      });
      const response = await context.state.transcriptRelays.start({
        room,
        workerUrl: getTranscriptWorkerUrl(),
        workerToken,
        controllerUserId: client.id,
        controllerDisplayName: displayName,
        canReplaceExistingRelay: isAdmin || isHost,
      });
      respond(callback, response);
    },
  );

  socket.on(
    "transcript:sfuRelayStop",
    async (
      callback: (
        response: TranscriptSfuRelayStopResponse | { error: string },
      ) => void,
    ) => {
      const room = context.currentRoom;
      const client = context.currentClient;
      if (!room || !client) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (client.isGhost || client.isWebinarAttendee) {
        respond(callback, {
          error: "Transcript relay is available to meeting participants only",
        });
        return;
      }
      const isAdmin = client instanceof Admin && !client.isObserver;
      const isHost = room.getHostUserId() === client.id;
      respond(
        callback,
        await context.state.transcriptRelays.stopRoomForUser({
          roomKey: room.channelId,
          userId: client.id,
          canStopAnyRelay: isAdmin || isHost,
        }),
      );
    },
  );
};
