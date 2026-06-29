import type { Consumer, ConsumerLayers } from "mediasoup/types";
import type {
  CloseConsumerData,
  ConsumeData,
  ConsumeResponse,
  ConsumerTelemetryNotification,
  ProduceData,
  ProduceResponse,
  ProducerInfo,
  SetConsumerPreferencesData,
  SetConsumerPreferencesResponse,
  ToggleMediaData,
} from "../../../types.js";
import type { Client } from "../../../config/classes/Client.js";
import type { Room } from "../../../config/classes/Room.js";
import { Logger } from "../../../utilities/loggers.js";
import { emitWebinarFeedChanged } from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

type ParseResult<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

const MAX_CONSUMER_LAYER = 10;
const MIN_CONSUMER_PRIORITY = 0;
const MAX_CONSUMER_PRIORITY = 255;
const MAX_MEDIA_ID_LENGTH = 256;
const DISPLACED_CONSUMER_CLOSE_DELAY_MS = 3000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeMediaId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_MEDIA_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

const parseConsumerLayers = (
  value: unknown,
): ParseResult<ConsumerLayers> => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Invalid consumer layer preference" };
  }

  const spatialLayer = Number(value.spatialLayer);
  const temporalLayer =
    value.temporalLayer === undefined ? undefined : Number(value.temporalLayer);

  if (
    !Number.isInteger(spatialLayer) ||
    spatialLayer < 0 ||
    spatialLayer > MAX_CONSUMER_LAYER
  ) {
    return { ok: false, error: "Invalid spatial layer" };
  }

  if (
    temporalLayer !== undefined &&
    (!Number.isInteger(temporalLayer) ||
      temporalLayer < 0 ||
      temporalLayer > MAX_CONSUMER_LAYER)
  ) {
    return { ok: false, error: "Invalid temporal layer" };
  }

  return {
    ok: true,
    value: {
      spatialLayer,
      ...(temporalLayer === undefined ? {} : { temporalLayer }),
    },
  };
};

const parseConsumerPriority = (
  value: unknown,
  options: { allowNull?: boolean } = {},
): ParseResult<number | null> => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null && options.allowNull) {
    return { ok: true, value: null };
  }

  const priority = Number(value);
  if (
    !Number.isInteger(priority) ||
    priority < MIN_CONSUMER_PRIORITY ||
    priority > MAX_CONSUMER_PRIORITY
  ) {
    return { ok: false, error: "Invalid consumer priority" };
  }

  return { ok: true, value: priority };
};

const isLayerCapableConsumer = (consumer: Consumer): boolean =>
  consumer.kind === "video" &&
  (consumer.type === "simulcast" || consumer.type === "svc");

const getDefaultConsumerLayers = (
  room: Room,
  client: Client,
  consumer: Consumer,
  producerInfo: ProducerInfo,
): ConsumerLayers | undefined => {
  if (!isLayerCapableConsumer(consumer) || producerInfo.type !== "webcam") {
    return undefined;
  }

  if (client.isWebinarAttendee) {
    return { spatialLayer: 0, temporalLayer: 1 };
  }

  if (room.currentQuality === "low") {
    return { spatialLayer: 0, temporalLayer: 1 };
  }

  return undefined;
};

const getDefaultConsumerPriority = (
  consumer: Consumer,
  producerInfo: ProducerInfo,
): number | undefined => {
  if (consumer.kind === "audio") {
    return 255;
  }

  if (consumer.kind !== "video") {
    return undefined;
  }

  if (producerInfo.type === "screen") {
    return 200;
  }

  return 100;
};

type ConsumerTelemetryTarget = {
  room: Room;
  client: Client;
  consumer: Consumer;
};

const emitConsumerTelemetry = (
  target: ConsumerTelemetryTarget,
  event: ConsumerTelemetryNotification["event"],
): void => {
  const { room, client, consumer } = target;

  const snapshot = client.updateConsumerTelemetry(consumer);
  if (!snapshot) {
    return;
  }

  client.socket.emit("consumerTelemetry", {
    event,
    roomId: room.id,
    userId: client.id,
    consumerId: snapshot.consumerId,
    producerId: snapshot.producerId,
    kind: snapshot.kind,
    score: snapshot.score,
    paused: snapshot.paused,
    producerPaused: snapshot.producerPaused,
    priority: snapshot.priority,
    preferredLayers: snapshot.preferredLayers,
    currentLayers: snapshot.currentLayers,
    timestamp: snapshot.updatedAt,
  } satisfies ConsumerTelemetryNotification);
};

const applyConsumerPreferences = async (
  target: ConsumerTelemetryTarget,
  options: {
    preferredLayers?: ConsumerLayers;
    priority?: number | null;
    paused?: boolean;
    requestKeyFrame?: boolean;
    explicitLayers?: boolean;
  },
): Promise<void> => {
  const { consumer } = target;

  if (options.preferredLayers) {
    if (isLayerCapableConsumer(consumer)) {
      try {
        await consumer.setPreferredLayers(options.preferredLayers);
      } catch (error) {
        if (options.explicitLayers) {
          throw error;
        }
        Logger.debug(
          `Could not set default layers for consumer ${consumer.id}: ${(error as Error).message}`,
        );
      }
    } else if (options.explicitLayers) {
      throw new Error("Consumer does not support layer preferences");
    }
  }

  if (options.priority !== undefined) {
    if (options.priority === null) {
      await consumer.unsetPriority();
    } else {
      await consumer.setPriority(options.priority);
    }
  }

  if (options.paused !== undefined) {
    if (options.paused) {
      await consumer.pause();
    } else {
      await consumer.resume();
    }
  }

  if (options.requestKeyFrame && consumer.kind === "video") {
    await consumer.requestKeyFrame();
  }

  emitConsumerTelemetry(target, "preferences");
};

export const registerMediaHandlers = (context: ConnectionContext): void => {
  const { socket, state, io } = context;
  const requestVideoKeyFrameForProducer = async (
    roomChannelId: string,
    producerId: string,
    ownerUserId: string,
  ): Promise<void> => {
    const activeRoom = state.rooms.get(roomChannelId);
    if (!activeRoom) return;

    const keyFrameRequests: Promise<void>[] = [];
    for (const [targetClientId, targetClient] of activeRoom.clients.entries()) {
      if (targetClientId === ownerUserId) continue;
      const consumer = targetClient.getConsumer(producerId);
      if (!consumer || consumer.closed || consumer.kind !== "video") {
        continue;
      }
      keyFrameRequests.push(
        consumer.requestKeyFrame().catch((error) => {
          Logger.warn(
            `Failed to request keyframe for producer ${producerId} on consumer ${consumer.id}:`,
            error,
          );
        }),
      );
    }
    await Promise.all(keyFrameRequests);
  };

  socket.on(
    "produce",
    async (
      data: ProduceData,
      callback: (response: ProduceResponse | { error: string }) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;

        if (!room || !currentClient?.producerTransport) {
          respond(callback, { error: "Not ready to produce" });
          return;
        }
        if (currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot produce media",
          });
          return;
        }

        if (!takeToken(socket, "mediaProduce", RATE_LIMITS.mediaProduce)) {
          respond(callback, {
            error: "Too many media publish requests; please retry shortly",
          });
          return;
        }

        if (
          data?.transportId &&
          normalizeMediaId(data.transportId) !== currentClient.producerTransport.id
        ) {
          respond(callback, { error: "Stale producer transport" });
          return;
        }

        const kind = data?.kind;
        if (kind !== "audio" && kind !== "video") {
          respond(callback, { error: "Invalid media kind" });
          return;
        }
        if (!isRecord(data?.rtpParameters)) {
          respond(callback, { error: "Invalid RTP parameters" });
          return;
        }
        const appData: Record<string, unknown> = isRecord(data?.appData)
          ? data.appData
          : {};
        const type =
          appData.type === "screen"
            ? "screen"
            : appData.type === "webcam" || appData.type === undefined
              ? "webcam"
              : null;
        if (!type) {
          respond(callback, { error: "Invalid producer type" });
          return;
        }
        const paused = appData.paused === true;
        const rtpParameters = data.rtpParameters;

        const isScreenShareVideo = type === "screen" && kind === "video";
        const isScreenShareAudio = type === "screen" && kind === "audio";

        if (isScreenShareVideo) {
          const existingScreenShare = room.screenShareProducerId;
          if (existingScreenShare) {
            respond(callback, { error: "Screen is already being shared" });
            return;
          }
        } else if (isScreenShareAudio) {
          const existingScreenVideo = currentClient.getProducer("video", "screen");
          if (!existingScreenVideo) {
            respond(callback, {
              error: "Screen share audio requires an active screen share",
            });
            return;
          }
        }

        const producer = await currentClient.producerTransport.produce({
          kind,
          rtpParameters,
          appData: { type },
          paused,
        });

        const roomChannelId = room.channelId;
        const clientId = currentClient.id;
        let producerClosed = false;
        let producerAdvertised = false;
        const notifyProducerClosed = () => {
          if (producerClosed) return;
          producerClosed = true;

          Logger.info(`Producer closed: ${producer.id}`);
          const activeRoom = state.rooms.get(roomChannelId);
          if (!activeRoom) return;

          if (producer.id === activeRoom.screenShareProducerId) {
            activeRoom.clearScreenShareProducer(producer.id);
          }

          if (producerAdvertised) {
            for (const [targetClientId, targetClient] of activeRoom.clients) {
              if (targetClient.isWebinarAttendee) {
                continue;
              }
              targetClient.socket.emit("producerClosed", {
                producerId: producer.id,
                producerUserId: clientId,
                roomId: activeRoom.id,
              });
            }
          }

          emitWebinarFeedChanged(io, state, activeRoom);
          if (kind === "audio") {
            void state.transcriptRelays.syncRoom(activeRoom);
          }
        };

        producer.on("transportclose", notifyProducerClosed);
        producer.observer.on("close", notifyProducerClosed);

        const syncProducerPausedState = async () => {
          const activeRoom = state.rooms.get(roomChannelId);
          if (!activeRoom) return;
          const ownerClient = activeRoom.getClient(clientId);
          if (!ownerClient) return;

          if (type === "webcam" && kind === "audio") {
            ownerClient.isMuted = producer.paused;
            socket.to(activeRoom.channelId).emit("participantMuted", {
              userId: clientId,
              muted: producer.paused,
              roomId: activeRoom.id,
            });
          } else if (type === "webcam" && kind === "video") {
            ownerClient.isCameraOff = producer.paused;
            socket.to(activeRoom.channelId).emit("participantCameraOff", {
              userId: clientId,
              cameraOff: producer.paused,
              roomId: activeRoom.id,
            });
            if (!producer.paused) {
              await requestVideoKeyFrameForProducer(
                roomChannelId,
                producer.id,
                clientId,
              );
            }
          }
          emitWebinarFeedChanged(io, state, activeRoom);
          if (kind === "audio") {
            void state.transcriptRelays.syncRoom(activeRoom);
          }
        };

        producer.observer.on("pause", () => {
          void syncProducerPausedState();
        });
        producer.observer.on("resume", () => {
          void syncProducerPausedState();
        });

        if (isScreenShareVideo) {
          room.setScreenShareProducer(producer.id);
        }

        const displacedProducer = currentClient.addProducer(producer);
        room.indexClientProducer(currentClient.id, producer, type);
        await room.registerWebinarAudioProducer(
          currentClient.id,
          producer,
          type,
        );
        if (kind === "audio") {
          void state.transcriptRelays.syncRoom(room);
        }

        const activeRoom = state.rooms.get(roomChannelId);
        const activeClient = activeRoom?.getClient(clientId);
        const producerStillActive = Boolean(
          activeClient && activeRoom?.getProducerInfoById(producer.id),
        );

        if (producer.closed || producerClosed || !activeRoom || !producerStillActive) {
          notifyProducerClosed();
          respond(callback, { error: "Producer closed during setup" });
          return;
        }

        producerAdvertised = true;
        const producingClient = activeRoom.getClient(clientId);
        for (const [targetClientId, client] of activeRoom.clients) {
          if (targetClientId === clientId || client.isWebinarAttendee) {
            continue;
          }
          if (producingClient?.isGhost && !client.isGhost) {
            continue;
          }
          client.socket.emit("newProducer", {
            producerId: producer.id,
            producerUserId: clientId,
            kind,
            type,
            paused: producer.paused,
            roomId: activeRoom.id,
          });
        }
        if (
          displacedProducer &&
          displacedProducer.id !== producer.id &&
          !displacedProducer.closed
        ) {
          try {
            displacedProducer.close();
          } catch {}
        }
        emitWebinarFeedChanged(io, state, activeRoom);

        Logger.info(
          `User ${clientId} started producing ${kind} (${type}): ${producer.id}`,
        );

        respond(callback, { producerId: producer.id });
      } catch (error) {
        Logger.error("Error producing:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consume",
    async (
      data: ConsumeData,
      callback: (response: ConsumeResponse | { error: string }) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;
        if (!room || !currentClient?.consumerTransport) {
          respond(callback, { error: "Not ready to consume" });
          return;
        }

        const producerId = normalizeMediaId(data?.producerId);
        if (!producerId) {
          respond(callback, { error: "Producer ID is required" });
          return;
        }
        const rtpCapabilities = data?.rtpCapabilities;
        if (!isRecord(rtpCapabilities)) {
          respond(callback, { error: "Invalid RTP capabilities" });
          return;
        }
        const producerInfo = room.getProducerInfoById(producerId);
        if (!producerInfo) {
          respond(callback, { error: "Producer not found" });
          return;
        }

        if (!room.canConsume(producerId, rtpCapabilities)) {
          respond(callback, { error: "Cannot consume this producer" });
          return;
        }

        if (
          data?.transportId &&
          normalizeMediaId(data.transportId) !== currentClient.consumerTransport.id
        ) {
          respond(callback, { error: "Stale consumer transport" });
          return;
        }

        const requestedLayers = parseConsumerLayers(data.preferredLayers);
        if (!requestedLayers.ok) {
          respond(callback, { error: requestedLayers.error });
          return;
        }
        const requestedPriority = parseConsumerPriority(data.priority);
        if (!requestedPriority.ok) {
          respond(callback, { error: requestedPriority.error });
          return;
        }

        const consumer = await currentClient.consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        const displacedConsumer = currentClient.addConsumer(consumer, {
          producerUserId: producerInfo.producerUserId,
          type: producerInfo.type,
        });
        const telemetryTarget = { room, client: currentClient, consumer };

        consumer.on("score", () => {
          emitConsumerTelemetry(telemetryTarget, "score");
        });
        consumer.on("layerschange", () => {
          emitConsumerTelemetry(telemetryTarget, "layerschange");
        });
        consumer.on("producerpause", () => {
          emitConsumerTelemetry(telemetryTarget, "producerpause");
        });
        consumer.on("producerresume", () => {
          emitConsumerTelemetry(telemetryTarget, "producerresume");
        });
        consumer.observer.on("pause", () => {
          emitConsumerTelemetry(telemetryTarget, "pause");
        });
        consumer.observer.on("resume", () => {
          emitConsumerTelemetry(telemetryTarget, "resume");
        });

        await applyConsumerPreferences(telemetryTarget, {
          preferredLayers:
            requestedLayers.value ??
            getDefaultConsumerLayers(room, currentClient, consumer, producerInfo),
          priority:
            requestedPriority.value ??
            getDefaultConsumerPriority(consumer, producerInfo),
          // Initial consume-time layer preferences are startup hints. If a
          // browser/producer cannot expose layers, keep the consumer alive and let
          // the later explicit setConsumerPreferences path report/fallback.
          explicitLayers: false,
        });

        consumer.on("transportclose", () => {
          Logger.info(`Consumer transport closed: ${consumer.id}`);
        });

        consumer.on("producerclose", () => {
          Logger.info(`Producer closed for consumer: ${consumer.id}`);
          emitConsumerTelemetry(telemetryTarget, "closed");
          socket.emit("producerClosed", {
            producerId,
            roomId: room.id,
          });
        });

        emitConsumerTelemetry(telemetryTarget, "created");

        respond(callback, {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          producerPaused: consumer.producerPaused,
          score: consumer.score,
          preferredLayers: consumer.preferredLayers,
          currentLayers: consumer.currentLayers,
          priority: consumer.priority,
        });

        if (displacedConsumer && !displacedConsumer.closed) {
          setTimeout(() => {
            try {
              if (!displacedConsumer.closed) {
                displacedConsumer.close();
              }
            } catch {}
          }, DISPLACED_CONSUMER_CLOSE_DELAY_MS).unref?.();
        }
      } catch (error) {
        Logger.error("Error consuming:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "getProducers",
    (
      callback: (
        response: { producers: ProducerInfo[] } | { error: string },
      ) => void,
    ) => {
      try {
        if (!context.currentRoom || !context.currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        const producers = context.currentClient.isWebinarAttendee
          ? context.currentRoom.getWebinarFeedSnapshot().producers
          : context.currentRoom.getAllProducers(context.currentClient.id, {
              includeGhostProducers: context.currentClient.isGhost,
            });
        respond(callback, { producers });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "resumeConsumer",
    async (
      data: { consumerId: string; requestKeyFrame?: boolean },
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;
        if (!room || !currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        if (!takeToken(socket, "resumeConsumer", RATE_LIMITS.consumerControl)) {
          respond(callback, {
            error: "Too many consumer control requests; please retry shortly",
          });
          return;
        }

        const consumerId = normalizeMediaId(data?.consumerId);
        if (!consumerId) {
          respond(callback, { error: "Consumer ID is required" });
          return;
        }

        const consumer = currentClient.getConsumerById(consumerId);
        if (!consumer) {
          respond(callback, { error: "Consumer not found" });
          return;
        }

        const wasPaused = consumer.paused;
        if (wasPaused) {
          await consumer.resume();
        }

        if (
          consumer.kind === "video" &&
          (data.requestKeyFrame === true || wasPaused)
        ) {
          try {
            await consumer.requestKeyFrame();
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            Logger.debug(
              `Skipped keyframe request for stale consumer ${consumer.id}: ${errorMessage}`,
            );
          }
        }

        emitConsumerTelemetry(
          { room, client: currentClient, consumer },
          wasPaused ? "resume" : "preferences",
        );
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "closeConsumer",
    (
      data: CloseConsumerData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;
        if (!room || !currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        if (!takeToken(socket, "closeConsumer", RATE_LIMITS.consumerControl)) {
          respond(callback, {
            error: "Too many consumer control requests; please retry shortly",
          });
          return;
        }

        const consumerId = normalizeMediaId(data?.consumerId);
        if (!consumerId) {
          respond(callback, { error: "Consumer ID is required" });
          return;
        }

        const consumer = currentClient.getConsumerById(consumerId);
        if (!consumer) {
          respond(callback, { success: true });
          return;
        }

        consumer.close();
        try {
          emitConsumerTelemetry({ room, client: currentClient, consumer }, "closed");
        } catch (telemetryError) {
          Logger.warn(
            `Failed to emit close telemetry for consumer ${consumerId}: ${
              telemetryError instanceof Error
                ? telemetryError.message
                : String(telemetryError)
            }`,
          );
        }
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "setConsumerPreferences",
    async (
      data: SetConsumerPreferencesData,
      callback: (
        response: SetConsumerPreferencesResponse | { error: string },
      ) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;
        if (!room || !currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        if (!takeToken(socket, "setConsumerPreferences", RATE_LIMITS.consumerControl)) {
          respond(callback, {
            error: "Too many consumer control requests; please retry shortly",
          });
          return;
        }

        const consumerId = normalizeMediaId(data?.consumerId);
        if (!consumerId) {
          respond(callback, { error: "Consumer ID is required" });
          return;
        }

        const consumer = currentClient.getConsumerById(consumerId);
        if (!consumer) {
          respond(callback, { error: "Consumer not found" });
          return;
        }

        const requestedLayers = parseConsumerLayers(data.preferredLayers);
        if (!requestedLayers.ok) {
          respond(callback, { error: requestedLayers.error });
          return;
        }

        const requestedPriority = parseConsumerPriority(data.priority, {
          allowNull: true,
        });
        if (!requestedPriority.ok) {
          respond(callback, { error: requestedPriority.error });
          return;
        }

        await applyConsumerPreferences({ room, client: currentClient, consumer }, {
          preferredLayers: requestedLayers.value,
          priority: requestedPriority.value,
          paused:
            typeof data?.paused === "boolean" ? data.paused : undefined,
          requestKeyFrame: data?.requestKeyFrame === true,
          explicitLayers: requestedLayers.value !== undefined,
        });

        respond(callback, {
          success: true,
          consumerId: consumer.id,
          producerId: consumer.producerId,
          paused: consumer.paused,
          producerPaused: consumer.producerPaused,
          priority: consumer.priority,
          preferredLayers: consumer.preferredLayers,
          currentLayers: consumer.currentLayers,
        });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "toggleMute",
    async (
      data: ToggleMediaData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot control microphones",
          });
          return;
        }
        if (typeof data?.paused !== "boolean") {
          respond(callback, { error: "Invalid mute state" });
          return;
        }

        const audioProducer = context.currentClient.getProducer("audio", "webcam");
        if (!audioProducer) {
          respond(callback, { error: "Microphone producer not found" });
          return;
        }

        if (data.paused) {
          await audioProducer.pause();
        } else {
          await audioProducer.resume();
        }

        const muted = audioProducer.paused;
        context.currentClient.isMuted = muted;

        socket.to(context.currentRoom.channelId).emit("participantMuted", {
          userId: context.currentClient.id,
          muted,
          roomId: context.currentRoom.id,
        });
        emitWebinarFeedChanged(io, state, context.currentRoom);
        void state.transcriptRelays.syncRoom(context.currentRoom);

        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "toggleCamera",
    async (
      data: ToggleMediaData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot control cameras",
          });
          return;
        }
        if (typeof data?.paused !== "boolean") {
          respond(callback, { error: "Invalid camera state" });
          return;
        }

        const videoProducer = context.currentClient.getProducer("video", "webcam");
        if (!videoProducer) {
          respond(callback, { error: "Camera producer not found" });
          return;
        }

        if (data.paused) {
          await videoProducer.pause();
        } else {
          await videoProducer.resume();
        }

        const cameraOff = videoProducer.paused;
        context.currentClient.isCameraOff = cameraOff;

        socket.to(context.currentRoom.channelId).emit("participantCameraOff", {
          userId: context.currentClient.id,
          cameraOff,
          roomId: context.currentRoom.id,
        });
        emitWebinarFeedChanged(io, state, context.currentRoom);

        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "closeProducer",
    async (
      data: { producerId: string },
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot close producers",
          });
          return;
        }
        const producerId = normalizeMediaId(data?.producerId);
        if (!producerId) {
          respond(callback, { error: "Producer ID is required" });
          return;
        }

        const removed = context.currentClient.removeProducerById(producerId);
        if (removed) {
          context.currentRoom.removeProducerIndexById(producerId);
          if (removed.type === "screen") {
            context.currentRoom.clearScreenShareProducer(producerId);
          } else if (removed.kind === "audio") {
            context.currentClient.isMuted = true;
            socket.to(context.currentRoom.channelId).emit("participantMuted", {
              userId: context.currentClient.id,
              muted: true,
              roomId: context.currentRoom.id,
            });
          } else if (removed.kind === "video") {
            context.currentClient.isCameraOff = true;
            socket.to(context.currentRoom.channelId).emit("participantCameraOff", {
              userId: context.currentClient.id,
              cameraOff: true,
              roomId: context.currentRoom.id,
            });
          }

          for (const [clientId, client] of context.currentRoom.clients) {
            if (clientId === context.currentClient.id || client.isWebinarAttendee) {
              continue;
            }
            client.socket.emit("producerClosed", {
              producerId,
              producerUserId: context.currentClient.id,
              roomId: context.currentRoom.id,
            });
          }
          emitWebinarFeedChanged(io, state, context.currentRoom);
          if (removed.kind === "audio") {
            void state.transcriptRelays.syncRoom(context.currentRoom);
          }

          respond(callback, { success: true });
          return;
        }

        if (context.currentRoom.screenShareProducerId === producerId) {
          context.currentRoom.clearScreenShareProducer(producerId);
          emitWebinarFeedChanged(io, state, context.currentRoom);
        }

        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
