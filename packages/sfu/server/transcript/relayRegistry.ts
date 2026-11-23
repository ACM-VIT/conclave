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
  handOver: (options: { roomKey: string; fromUserId: string; toUserId: string }) => void;
  releaseSeat: (options: { roomKey: string; userId: string }) => Promise<void>;
  syncRoom: (room: Room) => Promise<void>;
  closeAll: () => void;
};

type RoomRelays = {
  serving: TranscriptRelayInstance | null;
  starting: TranscriptRelayInstance | null;
};

export const createTranscriptRelayRegistry = (options: {
  enabled: boolean;
  createRelay?: (
    options: Omit<TranscriptRelayStartOptions, "canReplaceExistingRelay"> & {
      onClosed?: (message: string) => void;
    },
  ) => TranscriptRelayInstance;
}): TranscriptRelayRegistry => {
  const rooms = new Map<string, RoomRelays>();
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

  const failed = (reason: string): TranscriptSfuRelayStartResponse => ({
    mode: "sfu",
    success: false,
    status: "error",
    reason,
    updatedAt: Date.now(),
  });

  const forget = (key: string, slot: RoomRelays): void => {
    if (!slot.serving && !slot.starting && rooms.get(key) === slot) {
      rooms.delete(key);
    }
  };

  const stopServing = async (
    key: string,
    relay: TranscriptRelayInstance,
  ): Promise<void> => {
    const handoffReady = await relay.prepareHandoff();
    if (!handoffReady) {
      Logger.warn(
        `Transcript SFU relay stop for room ${key} could not prepare worker disconnect suppression.`,
      );
    }
    relay.close({ flushBufferedAudio: true });
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
      const slot = rooms.get(key) ?? { serving: null, starting: null };
      const current = slot.starting ?? slot.serving;
      if (
        current &&
        current.controllerUserId !== startOptions.controllerUserId &&
        !startOptions.canReplaceExistingRelay
      ) {
        return failed("An SFU transcript relay is already controlled by another participant.");
      }
      rooms.set(key, slot);

      const relay: TranscriptRelayInstance = (options.createRelay ?? ((relayOptions) =>
        new SfuTranscriptRelay(relayOptions)))({
        room: startOptions.room,
        workerUrl: startOptions.workerUrl,
        workerToken: startOptions.workerToken,
        controllerUserId: startOptions.controllerUserId,
        controllerDisplayName: startOptions.controllerDisplayName,
        onClosed: () => {
          if (slot.serving === relay) slot.serving = null;
          if (slot.starting === relay) slot.starting = null;
          forget(key, slot);
        },
      });
      slot.starting = relay;
      try {
        await relay.start();
        if (slot.starting === relay && slot.serving) {
          const handoffReady = await relay.prepareHandoff();
          if (!handoffReady && slot.starting === relay) {
            slot.starting = null;
            relay.close();
            forget(key, slot);
            return failed("Transcript worker did not prepare SFU relay handoff.");
          }
        }
        if (slot.starting !== relay) {
          relay.close();
          forget(key, slot);
          return failed("A newer SFU transcript relay start superseded this request.");
        }
        const previous = slot.serving;
        slot.serving = relay;
        slot.starting = null;
        previous?.close();
        return {
          mode: "sfu",
          success: true,
          status: "available",
          updatedAt: Date.now(),
        };
      } catch (error) {
        if (slot.starting === relay) slot.starting = null;
        relay.close();
        forget(key, slot);
        return failed(
          error instanceof Error ? error.message : "Failed to start SFU transcript relay.",
        );
      }
    },
    stopRoom(roomKey) {
      const slot = rooms.get(roomKey);
      if (!slot) return { success: true };
      rooms.delete(roomKey);
      const serving = slot.serving;
      slot.serving = null;
      slot.starting = null;
      serving?.close();
      return { success: true };
    },
    async stopRoomForUser({ roomKey, userId, canStopAnyRelay }) {
      const slot = rooms.get(roomKey);
      const current = slot ? slot.starting ?? slot.serving : null;
      if (!slot || !current) return { success: true };
      if (!canStopAnyRelay && current.controllerUserId !== userId) {
        return {
          error: "Only the transcript relay controller, host, or admin can stop the SFU relay.",
        };
      }
      const serving = slot.serving;
      slot.serving = null;
      slot.starting = null;
      forget(roomKey, slot);
      if (serving) await stopServing(roomKey, serving);
      return { success: true };
    },
    handOver({ roomKey, fromUserId, toUserId }) {
      const slot = rooms.get(roomKey);
      if (!slot) return;
      for (const relay of [slot.serving, slot.starting]) {
        if (relay?.controllerUserId === fromUserId) relay.controllerUserId = toUserId;
      }
    },
    async releaseSeat({ roomKey, userId }) {
      const slot = rooms.get(roomKey);
      if (!slot) return;
      if (slot.starting?.controllerUserId === userId) slot.starting = null;
      const serving = slot.serving?.controllerUserId === userId ? slot.serving : null;
      if (serving) slot.serving = null;
      forget(roomKey, slot);
      if (serving) await stopServing(roomKey, serving);
    },
    async syncRoom(room) {
      const slot = rooms.get(roomKey(room));
      if (!slot) return;
      for (const relay of [slot.serving, slot.starting]) {
        if (!relay) continue;
        try {
          await relay.syncProducers();
        } catch (error) {
          Logger.warn(
            `Transcript SFU relay sync failed for room ${room.id} (${room.clientId})`,
            error,
          );
        }
      }
    },
    closeAll() {
      for (const slot of rooms.values()) {
        slot.serving?.close();
        slot.serving = null;
        slot.starting = null;
      }
      rooms.clear();
    },
  };
};
