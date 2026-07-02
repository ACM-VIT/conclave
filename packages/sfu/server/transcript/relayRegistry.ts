import type { Room } from "../../config/classes/Room.js";
import type {
  TranscriptSfuRelayStartResponse,
  TranscriptSfuRelayStatusResponse,
  TranscriptSfuRelayStopResponse,
} from "../../types.js";
import { Logger } from "../../utilities/loggers.js";
import { SfuTranscriptRelay } from "./sfuTranscriptRelay.js";

type TranscriptRelayInstance = Pick<
  SfuTranscriptRelay,
  "controllerUserId" | "start" | "prepareHandoff" | "syncProducers" | "close"
>;

type TranscriptRelayStartOptions = {
  room: Room;
  workerUrl: string;
  workerToken: string;
  controllerUserId: string;
  controllerDisplayName: string;
  canReplaceExistingRelay: boolean;
};

export type TranscriptRelayRegistry = {
  getStatus: () => TranscriptSfuRelayStatusResponse;
  start: (options: TranscriptRelayStartOptions) => Promise<TranscriptSfuRelayStartResponse>;
  stopRoom: (roomKey: string) => TranscriptSfuRelayStopResponse;
  stopRoomForUser: (options: {
    roomKey: string;
    userId: string;
    canStopAnyRelay: boolean;
  }) => Promise<TranscriptSfuRelayStopResponse | { error: string }>;
  syncRoom: (room: Room) => Promise<void>;
  closeAll: () => void;
};

export const createTranscriptRelayRegistry = (options: {
  enabled: boolean;
  createRelay?: (
    options: Omit<TranscriptRelayStartOptions, "canReplaceExistingRelay"> & {
      onClosed?: (message: string) => void;
    },
  ) => TranscriptRelayInstance;
}): TranscriptRelayRegistry => {
  const relays = new Map<string, TranscriptRelayInstance>();
  const roomKey = (room: Pick<Room, "channelId" | "id">): string =>
    room.channelId || room.id;

  const getStatus = (): TranscriptSfuRelayStatusResponse => {
    if (!options.enabled) {
      return {
        mode: "sfu",
        status: "disabled",
        available: false,
        reason: "SFU transcript relay is disabled on this server.",
        updatedAt: Date.now(),
      };
    }
    return {
      mode: "sfu",
      status: "available",
      available: true,
      updatedAt: Date.now(),
    };
  };

  return {
    getStatus,
    async start(startOptions) {
      const status = getStatus();
      if (!status.available) {
        return {
          mode: "sfu",
          success: false,
          status: status.status,
          reason: status.reason,
          updatedAt: status.updatedAt,
        };
      }

      const key = roomKey(startOptions.room);
      const existingRelay = relays.get(key);
      if (
        existingRelay &&
        existingRelay.controllerUserId !== startOptions.controllerUserId &&
        !startOptions.canReplaceExistingRelay
      ) {
        return {
          mode: "sfu",
          success: false,
          status: "error",
          reason: "An SFU transcript relay is already controlled by another participant.",
          updatedAt: Date.now(),
        };
      }

      const relay: TranscriptRelayInstance = (options.createRelay ?? ((relayOptions) =>
        new SfuTranscriptRelay(relayOptions)))({
        room: startOptions.room,
        workerUrl: startOptions.workerUrl,
        workerToken: startOptions.workerToken,
        controllerUserId: startOptions.controllerUserId,
        controllerDisplayName: startOptions.controllerDisplayName,
        onClosed: () => {
          if (relays.get(key) === relay) {
            relays.delete(key);
          }
        },
      });
      relays.set(key, relay);
      try {
        await relay.start();
        if (relays.get(key) !== relay) {
          relay.close();
          return {
            mode: "sfu",
            success: false,
            status: "error",
            reason: "A newer SFU transcript relay start superseded this request.",
            updatedAt: Date.now(),
          };
        }
        if (existingRelay && existingRelay !== relay) {
          const handoffReady = await relay.prepareHandoff();
          if (!handoffReady) {
            if (relays.get(key) === relay) {
              relays.set(key, existingRelay);
            }
            relay.close();
            return {
              mode: "sfu",
              success: false,
              status: "error",
              reason: "Transcript worker did not prepare SFU relay handoff.",
              updatedAt: Date.now(),
            };
          }
          existingRelay.close();
        }
        return {
          mode: "sfu",
          success: true,
          status: "available",
          updatedAt: Date.now(),
        };
      } catch (error) {
        if (relays.get(key) === relay) {
          if (existingRelay) {
            relays.set(key, existingRelay);
          } else {
            relays.delete(key);
          }
        }
        relay.close();
        return {
          mode: "sfu",
          success: false,
          status: "error",
          reason:
            error instanceof Error
              ? error.message
              : "Failed to start SFU transcript relay.",
          updatedAt: Date.now(),
        };
      }
    },
    stopRoom(roomKey) {
      relays.get(roomKey)?.close();
      relays.delete(roomKey);
      return { success: true };
    },
    async stopRoomForUser({ roomKey, userId, canStopAnyRelay }) {
      const relay = relays.get(roomKey);
      if (!relay) return { success: true };
      if (!canStopAnyRelay && relay.controllerUserId !== userId) {
        return {
          error: "Only the transcript relay controller, host, or admin can stop the SFU relay.",
        };
      }
      const handoffReady = await relay.prepareHandoff();
      if (!handoffReady) {
        Logger.warn(
          `Transcript SFU relay stop for room ${roomKey} could not prepare worker disconnect suppression.`,
        );
      }
      relay.close({ flushBufferedAudio: true });
      relays.delete(roomKey);
      return { success: true };
    },
    async syncRoom(room) {
      try {
        await relays.get(roomKey(room))?.syncProducers();
      } catch (error) {
        Logger.warn(
          `Transcript SFU relay sync failed for room ${room.id} (${room.clientId})`,
          error,
        );
      }
    },
    closeAll() {
      for (const relay of relays.values()) {
        relay.close();
      }
      relays.clear();
    },
  };
};
