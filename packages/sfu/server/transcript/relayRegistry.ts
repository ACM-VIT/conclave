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
  // Every relay opened for a room and not yet closed, by creation order. A
  // start that loses a race or a stop must not leave an older relay running,
  // and must never close one created after it.
  const opened = new Map<string, Map<TranscriptRelayInstance, number>>();
  // The outcome of every start still in flight, by its relay. A start that
  // a newer one overtakes waits for this before it reports anything.
  const startsInFlight = new Map<
    TranscriptRelayInstance,
    Promise<TranscriptSfuRelayStartResponse>
  >();
  let nextGeneration = 0;
  const roomKey = (room: Pick<Room, "channelId" | "id">): string =>
    room.channelId || room.id;
  const forget = (key: string, relay: TranscriptRelayInstance): void => {
    const roomRelays = opened.get(key);
    roomRelays?.delete(relay);
    if (roomRelays?.size === 0) opened.delete(key);
  };
  const closeRelay = (
    key: string,
    relay: TranscriptRelayInstance,
    closeOptions?: Parameters<TranscriptRelayInstance["close"]>[0],
  ): void => {
    forget(key, relay);
    relay.close(closeOptions);
  };
  const closeOlderThan = (key: string, generation: number): void => {
    for (const [relay, relayGeneration] of Array.from(opened.get(key) ?? [])) {
      if (relayGeneration < generation) closeRelay(key, relay);
    }
  };
  const closeRoom = (key: string): void => {
    for (const relay of Array.from(opened.get(key)?.keys() ?? [])) {
      closeRelay(key, relay);
    }
    relays.delete(key);
  };

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
          forget(key, relay);
          if (relays.get(key) === relay) {
            relays.delete(key);
          }
        },
      });
      const generation = nextGeneration++;
      const roomRelays =
        opened.get(key) ?? new Map<TranscriptRelayInstance, number>();
      opened.set(key, roomRelays.set(relay, generation));
      relays.set(key, relay);
      let settle!: (response: TranscriptSfuRelayStartResponse) => void;
      startsInFlight.set(
        relay,
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      const finish = (
        response: TranscriptSfuRelayStartResponse,
      ): TranscriptSfuRelayStartResponse => {
        startsInFlight.delete(relay);
        settle(response);
        return response;
      };
      const failure = (reason: string): TranscriptSfuRelayStartResponse => ({
        mode: "sfu",
        success: false,
        status: "error",
        reason,
        updatedAt: Date.now(),
      });
      const isOpen = (candidate: TranscriptRelayInstance): boolean =>
        opened.get(key)?.has(candidate) === true;
      // Report success only while a relay really runs. When a newer start
      // took the room, wait for it to settle: it either runs, so the room has
      // a relay, or it fails and hands the room back to this one, which
      // carries on. A room left with no relay fails, so the browser retries.
      const outcomeOfNewerStart = async (): Promise<TranscriptSfuRelayStartResponse | null> => {
        for (;;) {
          const current = relays.get(key);
          if (current === relay) return null;
          const newer = current ? startsInFlight.get(current) : undefined;
          if (newer) {
            await newer;
            continue;
          }
          if (isOpen(relay)) closeRelay(key, relay);
          return current && isOpen(current)
            ? { mode: "sfu", success: true, status: "available", updatedAt: Date.now() }
            : failure("No SFU transcript relay is running for this room.");
        }
      };
      // A failed start hands the room back to the relay before it, never to
      // one that has closed.
      const giveRoomBack = (): void => {
        if (relays.get(key) !== relay) return;
        if (existingRelay && existingRelay !== relay && isOpen(existingRelay)) {
          relays.set(key, existingRelay);
        } else {
          relays.delete(key);
        }
      };
      try {
        await relay.start();
      } catch (error) {
        const settled = await outcomeOfNewerStart();
        if (settled) return finish(settled);
        giveRoomBack();
        closeRelay(key, relay);
        return finish(
          failure(error instanceof Error ? error.message : "Failed to start SFU transcript relay."),
        );
      }
      const overtaken = await outcomeOfNewerStart();
      if (overtaken) return finish(overtaken);
      if (existingRelay && existingRelay !== relay) {
        const handoffReady = await relay.prepareHandoff();
        const overtakenDuringHandoff = await outcomeOfNewerStart();
        if (overtakenDuringHandoff) return finish(overtakenDuringHandoff);
        if (!handoffReady) {
          giveRoomBack();
          closeRelay(key, relay);
          return finish(failure("Transcript worker did not prepare SFU relay handoff."));
        }
      }
      closeOlderThan(key, generation);
      return finish({
        mode: "sfu",
        success: true,
        status: "available",
        updatedAt: Date.now(),
      });
    },
    stopRoom(roomKey) {
      closeRoom(roomKey);
      return { success: true };
    },
    async stopRoomForUser({ roomKey, userId, canStopAnyRelay }) {
      const relay = relays.get(roomKey);
      if (!relay) return { success: true };
      const stoppedGeneration = opened.get(roomKey)?.get(relay) ?? -1;
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
      closeOlderThan(roomKey, stoppedGeneration);
      if (opened.get(roomKey)?.has(relay)) {
        closeRelay(roomKey, relay, { flushBufferedAudio: true });
      }
      // A host can start a replacement relay while prepareHandoff() awaits;
      // only remove the entry if it is still the relay this call stopped, or
      // the newer relay would keep running with no way to stop it.
      if (relays.get(roomKey) === relay) {
        relays.delete(roomKey);
      }
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
      for (const key of Array.from(opened.keys())) {
        closeRoom(key);
      }
      relays.clear();
    },
  };
};
