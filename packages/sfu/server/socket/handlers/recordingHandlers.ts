import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type {
  RecordingPublicState,
  RecordingSessionMetadata,
  StartRecordingRequest,
} from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

const ensureHostInRoom = (
  context: ConnectionContext,
): { ok: true } | { ok: false; error: string } => {
  if (!context.currentRoom || !context.currentClient) {
    return { ok: false, error: "Not in a room" };
  }
  if (!(context.currentClient instanceof Admin)) {
    return { ok: false, error: "Only hosts can control recording" };
  }
  return { ok: true };
};

const summarize = (
  metadata: RecordingSessionMetadata,
): RecordingSessionMetadata => ({
  ...metadata,
  tracks: metadata.tracks.map((track) => ({ ...track })),
});

export const registerRecordingHandlers = (
  context: ConnectionContext,
): void => {
  const { socket, recordings } = context;

  socket.on(
    "recording:start",
    async (
      data: StartRecordingRequest | undefined,
      callback: (
        response:
          | { success: true; state: RecordingPublicState }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureHostInRoom(context);
      if (!guard.ok) {
        respond(callback, { error: guard.error });
        return;
      }
      const room = context.currentRoom!;
      const userId = context.currentClient!.id;
      try {
        const session = await recordings.start(room, {
          startedBy: data?.startedBy || userId,
          audioBitrateKbps: data?.audioBitrateKbps,
          videoBitrateKbps: data?.videoBitrateKbps,
          preferredVideoCodec: data?.preferredVideoCodec,
          produceComposite: data?.composite,
        });
        respond(callback, { success: true, state: session.publicState() });
      } catch (error) {
        const message = (error as Error).message || "Failed to start recording";
        Logger.warn(`[recording] start failed: ${message}`);
        respond(callback, { error: message });
      }
    },
  );

  socket.on(
    "recording:stop",
    async (
      _data: undefined,
      callback: (
        response:
          | { success: true; metadata: RecordingSessionMetadata }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureHostInRoom(context);
      if (!guard.ok) {
        respond(callback, { error: guard.error });
        return;
      }
      const room = context.currentRoom!;
      const result = await recordings.stop(room.channelId, {
        endedBy: context.currentClient!.id,
      });
      if (!result) {
        respond(callback, { error: "No active recording" });
        return;
      }
      respond(callback, { success: true, metadata: summarize(result) });
    },
  );

  socket.on(
    "recording:pause",
    async (
      _data: undefined,
      callback: (
        response:
          | { success: true; state: RecordingPublicState }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureHostInRoom(context);
      if (!guard.ok) {
        respond(callback, { error: guard.error });
        return;
      }
      const room = context.currentRoom!;
      await recordings.pause(room.channelId);
      respond(callback, {
        success: true,
        state: recordings.publicState(room.channelId),
      });
    },
  );

  socket.on(
    "recording:resume",
    async (
      _data: undefined,
      callback: (
        response:
          | { success: true; state: RecordingPublicState }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureHostInRoom(context);
      if (!guard.ok) {
        respond(callback, { error: guard.error });
        return;
      }
      const room = context.currentRoom!;
      await recordings.resume(room.channelId);
      respond(callback, {
        success: true,
        state: recordings.publicState(room.channelId),
      });
    },
  );

  socket.on(
    "recording:getState",
    (
      _data: undefined,
      callback: (state: RecordingPublicState | { error: string }) => void,
    ) => {
      if (!context.currentRoom) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      respond(callback, recordings.publicState(context.currentRoom.channelId));
    },
  );
};
