import type { Consumer, ConsumerLayers, Producer } from "mediasoup/types";
import type {
  AbortConsumerHandoffData,
  AbortConsumerHandoffResponse,
  CloseConsumerData,
  ConsumeData,
  ConsumeResponse,
  ConsumerTelemetryNotification,
  ProduceData,
  ProduceResponse,
  ProducerInfo,
  SetConsumerPreferencesBatchData,
  SetConsumerPreferencesBatchResponse,
  SetConsumerPreferencesData,
  SetConsumerPreferencesResponse,
  ToggleMediaData,
} from "../../../types.js";
import type { Client } from "../../../config/classes/Client.js";
import type { Room } from "../../../config/classes/Room.js";
import { Logger } from "../../../utilities/loggers.js";
import {
  initConsumerHealState,
  markConsumerClientPausedIntent,
} from "../../audioConsumerHeal.js";
import {
  getVideoKeyFrameRequestDelayMs,
  parseConsumerPriority,
  shouldExplicitlyRequestConsumerKeyFrame,
} from "../../mediaPolicy.js";
import { emitWebinarFeedChanged } from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";
import type { ClientMediaCapabilities } from "../../webcamCodecPolicy.js";
import type { WebcamReceiverCapacityTransitionReservation } from "../../webcamReceiverCapacityProof.js";

type ParseResult<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

const MAX_CONSUMER_LAYER = 10;
const MAX_MEDIA_ID_LENGTH = 256;
const MAX_CONSUMER_PREFERENCE_BATCH_SIZE = 24;
// A consume acknowledgement can remain in flight for twelve seconds, and the
// receiver's generation handoff has its own absolute fifteen-second window.
// Keep the predecessor alive beyond both bounds so an unusually delayed ACK
// can still be rolled back without a visible blackout. Healthy clients close
// the predecessor explicitly as soon as the successor is proven, so this long
// fail-safe grace does not extend the normal overlap.
export const DISPLACED_CONSUMER_CLOSE_DELAY_MS = 30_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const TRANSITION_NONCE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const PLANNED_HANDOFF_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ConsumerGenerationDisplacedError extends Error {
  constructor() {
    super("Consumer generation displaced");
    this.name = "ConsumerGenerationDisplacedError";
  }
}

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

const parseWebcamReceiverCapacityTransition = (
  value: unknown,
): { fromProducerId: string; nonce: string } | null => {
  if (!isRecord(value)) return null;
  const fromProducerId = normalizeMediaId(value.fromProducerId);
  const nonce = value.nonce;
  if (
    !fromProducerId ||
    typeof nonce !== "string" ||
    !TRANSITION_NONCE_PATTERN.test(nonce)
  ) {
    return null;
  }
  return { fromProducerId, nonce };
};

const isRequestedVp8SingleLayer = (rtpParameters: unknown): boolean => {
  if (!isRecord(rtpParameters)) return false;
  const encodings = rtpParameters.encodings;
  const codecs = rtpParameters.codecs;
  const mediaCodecs = Array.isArray(codecs)
    ? codecs.filter((codec) => {
        if (!isRecord(codec) || typeof codec.mimeType !== "string") {
          return true;
        }
        return ![
          "video/rtx",
          "video/red",
          "video/ulpfec",
          "video/flexfec-03",
        ].includes(codec.mimeType.toLowerCase());
      })
    : [];
  return (
    Array.isArray(encodings) &&
    encodings.length === 1 &&
    mediaCodecs.length === 1 &&
    isRecord(mediaCodecs[0]) &&
    typeof mediaCodecs[0].mimeType === "string" &&
    mediaCodecs[0].mimeType.toLowerCase() === "video/vp8"
  );
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

const parsePlannedConsumerHandoff = (
  value: unknown,
): ParseResult<{ requestId: string; predecessorConsumerId: string }> => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Invalid planned consumer handoff" };
  }
  const requestId =
    typeof value.requestId === "string" ? value.requestId.trim() : "";
  const predecessorConsumerId = normalizeMediaId(
    value.predecessorConsumerId,
  );
  if (
    !PLANNED_HANDOFF_REQUEST_ID_PATTERN.test(requestId) ||
    !predecessorConsumerId
  ) {
    return { ok: false, error: "Invalid planned consumer handoff" };
  }
  return {
    ok: true,
    value: { requestId: requestId.toLowerCase(), predecessorConsumerId },
  };
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
  if (!isLayerCapableConsumer(consumer)) {
    return undefined;
  }

  if (producerInfo.type === "screen") {
    return {
      spatialLayer: 0,
      temporalLayer: 2,
    };
  }

  if (producerInfo.type !== "webcam") {
    return undefined;
  }

  if (client.isWebinarAttendee) {
    return { spatialLayer: 0, temporalLayer: 0 };
  }

  if (room.currentQuality === "low") {
    return { spatialLayer: 0, temporalLayer: 0 };
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
    return 240;
  }

  return 100;
};

type ConsumerTelemetryTarget = {
  room: Room;
  client: Client;
  consumer: Consumer;
};

const isCurrentConsumerGeneration = (
  client: Client,
  consumer: Consumer,
): boolean =>
  !consumer.closed && client.getConsumer(consumer.producerId) === consumer;

const assertCurrentConsumerGeneration = (
  target: ConsumerTelemetryTarget,
): void => {
  if (!isCurrentConsumerGeneration(target.client, target.consumer)) {
    throw new ConsumerGenerationDisplacedError();
  }
};

const emitConsumerTelemetry = (
  target: ConsumerTelemetryTarget,
  event: ConsumerTelemetryNotification["event"],
): void => {
  const { room, client, consumer } = target;

  // Capacity proof is derived from the live mediasoup Consumer, not the
  // receiver-facing telemetry cache. Refresh even if this event belongs to a
  // displaced consumer and updateConsumerTelemetry() rejects its snapshot.
  room.refreshWebcamReceiverCapacityProof(consumer.producerId);

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
  assertCurrentConsumerGeneration(target);

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
      assertCurrentConsumerGeneration(target);
    } else if (options.explicitLayers) {
      throw new Error("Consumer does not support layer preferences");
    }
  }

  if (options.priority !== undefined) {
    assertCurrentConsumerGeneration(target);
    if (options.priority === null) {
      await consumer.unsetPriority();
    } else {
      await consumer.setPriority(options.priority);
    }
    assertCurrentConsumerGeneration(target);
  }

  if (options.paused !== undefined) {
    assertCurrentConsumerGeneration(target);
    // Explicit pause/resume from the owning client. Recorded so the audio
    // heal sweep never resumes a consumer the client intentionally paused.
    markConsumerClientPausedIntent(consumer, options.paused);
    if (options.paused) {
      await consumer.pause();
    } else {
      await consumer.resume();
    }
    assertCurrentConsumerGeneration(target);
  }

  if (options.requestKeyFrame && consumer.kind === "video") {
    assertCurrentConsumerGeneration(target);
    await consumer.requestKeyFrame();
    assertCurrentConsumerGeneration(target);
  }

  assertCurrentConsumerGeneration(target);
  emitConsumerTelemetry(target, "preferences");
};

const buildSetConsumerPreferencesResponse = (
  consumer: Consumer,
): SetConsumerPreferencesResponse => ({
  success: true,
  consumerId: consumer.id,
  producerId: consumer.producerId,
  paused: consumer.paused,
  producerPaused: consumer.producerPaused,
  priority: consumer.priority,
  preferredLayers: consumer.preferredLayers,
  currentLayers: consumer.currentLayers,
});

const buildConsumeResponse = (
  consumer: Consumer,
  plannedConsumerHandoffRequestId?: string,
): ConsumeResponse => ({
  id: consumer.id,
  producerId: consumer.producerId,
  kind: consumer.kind,
  rtpParameters: consumer.rtpParameters,
  consumerType: consumer.type,
  paused: consumer.paused,
  producerPaused: consumer.producerPaused,
  score: consumer.score,
  preferredLayers: consumer.preferredLayers,
  currentLayers: consumer.currentLayers,
  priority: consumer.priority,
  ...(plannedConsumerHandoffRequestId
    ? { plannedConsumerHandoffRequestId }
    : {}),
});

const applyConsumerPreferencesData = async (
  room: Room,
  currentClient: Client,
  data: SetConsumerPreferencesData,
): Promise<SetConsumerPreferencesResponse | { error: string; consumerId?: string }> => {
  const consumerId = normalizeMediaId(data?.consumerId);
  if (!consumerId) {
    return { error: "Consumer ID is required" };
  }

  const consumer = currentClient.getConsumerById(consumerId);
  if (!consumer) {
    return { error: "Consumer not found", consumerId };
  }
  if (!isCurrentConsumerGeneration(currentClient, consumer)) {
    return { error: "Consumer generation displaced", consumerId };
  }

  const requestedLayers = parseConsumerLayers(data.preferredLayers);
  if (!requestedLayers.ok) {
    return { error: requestedLayers.error, consumerId };
  }

  const requestedPriority = parseConsumerPriority(data.priority, {
    allowNull: true,
  });
  if (!requestedPriority.ok) {
    return { error: requestedPriority.error, consumerId };
  }

  try {
    await applyConsumerPreferences({ room, client: currentClient, consumer }, {
      preferredLayers: requestedLayers.value,
      priority: requestedPriority.value,
      paused:
        typeof data?.paused === "boolean" ? data.paused : undefined,
      requestKeyFrame: data?.requestKeyFrame === true,
      explicitLayers: requestedLayers.value !== undefined,
    });
  } catch (error) {
    if (error instanceof ConsumerGenerationDisplacedError) {
      return { error: error.message, consumerId };
    }
    throw error;
  }

  if (!isCurrentConsumerGeneration(currentClient, consumer)) {
    return { error: "Consumer generation displaced", consumerId };
  }

  return buildSetConsumerPreferencesResponse(consumer);
};

export const registerMediaHandlers = (context: ConnectionContext): void => {
  const { socket, state, io } = context;

  socket.on(
    "updateMediaCapabilities",
    (
      data: { mediaCapabilities?: ClientMediaCapabilities },
      callback: (
        response:
          | { success: true; webcamCodecPolicy: Room["webcamCodecPolicy"] }
          | { error: string },
      ) => void,
    ) => {
      const room = context.currentRoom;
      const client = context.currentClient;
      if (!room || !client) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (
        !takeToken(
          socket,
          "updateMediaCapabilities",
          RATE_LIMITS.mediaCapabilities,
        )
      ) {
        respond(callback, { error: "Media capability update rate limited" });
        return;
      }
      const webcamCodecPolicy = room.updateClientMediaCapabilities(
        client.id,
        data?.mediaCapabilities,
      );
      if (!webcamCodecPolicy) {
        respond(callback, { error: "Invalid media capability update" });
        return;
      }
      respond(callback, { success: true, webcamCodecPolicy });
    },
  );

  socket.on(
    "reportWebcamCodecFailure",
    (
      data: { codec?: unknown; epoch?: unknown },
      callback: (
        response:
          | { success: true; webcamCodecPolicy: Room["webcamCodecPolicy"] }
          | { error: string },
      ) => void,
    ) => {
      const room = context.currentRoom;
      const client = context.currentClient;
      if (!room || !client) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (
        !takeToken(
          socket,
          "reportWebcamCodecFailure",
          RATE_LIMITS.mediaCodecFailure,
        )
      ) {
        respond(callback, { error: "Codec failure report rate limited" });
        return;
      }
      if (
        data?.codec !== "vp9" ||
        !Number.isInteger(data?.epoch) ||
        Number(data.epoch) < 0
      ) {
        respond(callback, { error: "Invalid codec failure report" });
        return;
      }

      const webcamCodecPolicy = room.reportClientWebcamCodecFailure(
        client.id,
        "vp9",
        Number(data.epoch),
      );
      if (!webcamCodecPolicy) {
        respond(callback, { error: "Stale or unsupported codec failure report" });
        return;
      }
      respond(callback, { success: true, webcamCodecPolicy });
    },
  );
  const requestVideoKeyFrameForProducer = async (
    roomChannelId: string,
    producerId: string,
    ownerUserId: string,
  ): Promise<number> => {
    const activeRoom = state.rooms.get(roomChannelId);
    if (!activeRoom) return 0;

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
    return keyFrameRequests.length;
  };

  socket.on(
    "requestProducerKeyFrame",
    async (
      data: { producerId?: unknown },
      callback: (
        response:
          | { success: true; requestedConsumerCount: number }
          | { error: string },
      ) => void,
    ) => {
      const room = context.currentRoom;
      const currentClient = context.currentClient;
      if (!room || !currentClient) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (
        !takeToken(
          socket,
          "requestProducerKeyFrame",
          RATE_LIMITS.producerKeyFrame,
        )
      ) {
        respond(callback, { error: "Producer key-frame request rate limited" });
        return;
      }

      const producerId = normalizeMediaId(data?.producerId);
      if (!producerId) {
        respond(callback, { error: "Invalid producer ID" });
        return;
      }
      const producer = currentClient.getProducer("video", "webcam");
      if (!producer || producer.closed || producer.id !== producerId) {
        respond(callback, { error: "Video producer not found" });
        return;
      }

      const requestedConsumerCount = await requestVideoKeyFrameForProducer(
        room.channelId,
        producerId,
        currentClient.id,
      );
      respond(callback, { success: true, requestedConsumerCount });
    },
  );

  socket.on(
    "produce",
    async (
      data: ProduceData,
      callback: (response: ProduceResponse | { error: string }) => void,
    ) => {
      let capacityTransitionReservation:
        | WebcamReceiverCapacityTransitionReservation
        | null = null;
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
        const transitionValue = appData.webcamReceiverCapacityTransition;
        const transitionIntent =
          transitionValue === undefined
            ? null
            : parseWebcamReceiverCapacityTransition(transitionValue);
        if (
          transitionValue !== undefined &&
          (!transitionIntent ||
            type !== "webcam" ||
            kind !== "video" ||
            paused ||
            !isRequestedVp8SingleLayer(rtpParameters))
        ) {
          respond(callback, {
            error: "Invalid webcam receiver-capacity transition",
          });
          return;
        }

        if (
          type === "webcam" &&
          kind === "video" &&
          !room.rtpParametersMatchCurrentWebcamCodecPolicy(rtpParameters)
        ) {
          respond(callback, {
            error:
              `Webcam codec policy changed; expected ${room.webcamCodecPolicy.mimeType}` +
              (room.webcamCodecPolicy.scalabilityMode
                ? ` ${room.webcamCodecPolicy.scalabilityMode}`
                : ""),
          });
          return;
        }

        const isScreenShareVideo = type === "screen" && kind === "video";
        const isScreenShareAudio = type === "screen" && kind === "audio";

        if (isScreenShareVideo) {
          const existingScreenShare = room.screenShareProducerId;
          if (existingScreenShare) {
            const existingScreenShareInfo =
              room.getProducerInfoById(existingScreenShare);
            if (!existingScreenShareInfo) {
              room.clearScreenShareProducer(existingScreenShare);
            } else if (existingScreenShareInfo.producerUserId !== currentClient.id) {
              respond(callback, { error: "Screen is already being shared" });
              return;
            } else {
              room.replaceScreenShareProducerForUser(
                existingScreenShare,
                currentClient.id,
              );
            }
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

        if (transitionIntent) {
          capacityTransitionReservation =
            room.reserveWebcamReceiverCapacityTransition(
              currentClient.id,
              transitionIntent.fromProducerId,
              transitionIntent.nonce,
            );
          if (!capacityTransitionReservation) {
            respond(callback, {
              error: "Webcam receiver-capacity transition is stale or already used",
            });
            return;
          }
        }

        const producer = await currentClient.producerTransport.produce({
          kind,
          rtpParameters,
          appData: { type },
          paused,
          // mediasoup forwards the first request immediately, then coalesces
          // repeat PLIs per SSRC. Webcam gets a short recovery window; screen
          // keyframes are much larger, so a longer window avoids fanout bursts.
          ...(kind === "video"
            ? { keyFrameRequestDelay: getVideoKeyFrameRequestDelayMs(type) }
            : {}),
        });

        // The room policy can change while mediasoup is creating the producer
        // (for example, an incompatible late join). Revalidate the actual
        // negotiated RTP before indexing or advertising it.
        if (
          type === "webcam" &&
          kind === "video" &&
          !room.rtpParametersMatchCurrentWebcamCodecPolicy(
            producer.rtpParameters,
          )
        ) {
          if (capacityTransitionReservation) {
            room.cancelWebcamReceiverCapacityTransition(
              capacityTransitionReservation,
            );
            capacityTransitionReservation = null;
          }
          try {
            producer.close();
          } catch {}
          respond(callback, {
            error: "Webcam codec policy changed during producer creation",
          });
          return;
        }

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
          if (type === "webcam" && kind === "video") {
            activeRoom.refreshWebcamReceiverCapacityProof(producer.id);
          }

          if (producerAdvertised) {
            for (const [, targetClient] of activeRoom.clients) {
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
            activeRoom.refreshWebcamReceiverCapacityProof(producer.id);
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
        if (type === "webcam" && kind === "video") {
          producer.observer.on("score", () => {
            const activeRoom = state.rooms.get(roomChannelId);
            activeRoom?.refreshWebcamReceiverCapacityProof(producer.id);
          });
        }

        if (isScreenShareVideo) {
          room.setScreenShareProducer(producer.id);
        }

        let displacedProducer: Producer | null;
        if (capacityTransitionReservation) {
          displacedProducer = room.commitWebcamReceiverCapacityTransition(
            currentClient.id,
            producer,
            capacityTransitionReservation,
          );
          capacityTransitionReservation = null;
          if (!displacedProducer) {
            try {
              producer.close();
            } catch {}
            respond(callback, {
              error: "Webcam receiver-capacity transition became invalid",
            });
            return;
          }
        } else {
          displacedProducer = currentClient.addProducer(producer);
          room.indexClientProducer(currentClient.id, producer, type);
        }
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
        for (const [targetClientId, client] of activeRoom.clients) {
          if (targetClientId === clientId || client.isWebinarAttendee) {
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
        if (capacityTransitionReservation) {
          context.currentRoom?.cancelWebcamReceiverCapacityTransition(
            capacityTransitionReservation,
          );
        }
        Logger.error("Error producing:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consume",
    async (
      data: ConsumeData,
      callback: (
        response: ConsumeResponse | { error: string; code?: string },
      ) => void,
    ) => {
      let ownedHandoff:
        | { client: Client; requestId: string }
        | undefined;
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
        if (!room.producerIdMatchesCurrentWebcamCodecPolicy(producerId)) {
          respond(callback, {
            error: "Webcam producer is being replaced for room codec policy",
          });
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
        const parsedHandoff = parsePlannedConsumerHandoff(
          data.plannedConsumerHandoff,
        );
        if (!parsedHandoff.ok) {
          respond(callback, { error: parsedHandoff.error });
          return;
        }
        const plannedHandoff = parsedHandoff.value;
        if (
          plannedHandoff &&
          (producerInfo.kind !== "video" || producerInfo.type !== "webcam")
        ) {
          respond(callback, {
            error: "Planned consumer handoff requires a webcam video producer",
          });
          return;
        }
        if (plannedHandoff) {
          const reservation = currentClient.reserveConsumerHandoff({
            requestId: plannedHandoff.requestId,
            producerId,
            predecessorConsumerId:
              plannedHandoff.predecessorConsumerId,
          });
          if (!reservation.isOwner) {
            const completion = await reservation.completion;
            if (!completion.ok) {
              respond(callback, {
                error: completion.error,
                ...(completion.code ? { code: completion.code } : {}),
              });
              return;
            }
            const duplicateConsumer = completion.consumer;
            if (
              duplicateConsumer.closed ||
              currentClient.getConsumer(producerId) !== duplicateConsumer
            ) {
              respond(callback, {
                error: "Planned consumer handoff is no longer current",
                code: "displaced",
              });
              return;
            }
            respond(
              callback,
              buildConsumeResponse(
                duplicateConsumer,
                plannedHandoff.requestId,
              ),
            );
            return;
          }
          ownedHandoff = {
            client: currentClient,
            requestId: plannedHandoff.requestId,
          };
        }

        // Video consumers start paused so the client can resume once its local
        // consumer exists and receive a clean keyframe. Audio needs no keyframe
        // and Opus decodes from any packet, so audio consumers start UNPAUSED:
        // delivery must never depend on a resumeConsumer round-trip that can be
        // rate-limited or lost (issue #177 — speaker audible to only a subset
        // of attendees). A resume for an unpaused consumer is a no-op.
        const consumer = await currentClient.consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: producerInfo.kind !== "audio",
        });
        if (
          plannedHandoff &&
          !currentClient.attachConsumerHandoff(
            plannedHandoff.requestId,
            consumer,
          )
        ) {
          try {
            consumer.close();
          } catch {}
          respond(callback, {
            error: "Planned consumer handoff was aborted during setup",
            code: "aborted",
          });
          return;
        }
        initConsumerHealState(consumer);

        currentClient.addConsumer(consumer, {
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

        try {
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
        } catch (error) {
          try {
            consumer.close();
          } catch {}
          if (!(error instanceof ConsumerGenerationDisplacedError)) {
            throw error;
          }
          if (plannedHandoff) {
            currentClient.failConsumerHandoff(
              plannedHandoff.requestId,
              "Consumer displaced during setup",
              "displaced",
            );
          }
          respond(callback, {
            error: "Consumer displaced during setup",
            code: "displaced",
          });
          return;
        }

        consumer.on("transportclose", () => {
          Logger.info(`Consumer transport closed: ${consumer.id}`);
          room.refreshWebcamReceiverCapacityProof(producerId);
        });

        consumer.observer.on("close", () => {
          room.refreshWebcamReceiverCapacityProof(producerId);
        });

        consumer.on("producerclose", () => {
          Logger.info(`Producer closed for consumer: ${consumer.id}`);
          emitConsumerTelemetry(telemetryTarget, "closed");
          socket.emit("producerClosed", {
            producerId,
            roomId: room.id,
          });
        });

        // A concurrent consume for the same producer can displace this
        // consumer while applyConsumerPreferences awaited above. Responding
        // with a displaced consumer id would hand the client a generation that
        // remains addressable only for targeted cleanup and cannot accept
        // controls. Error out so the client's retry path re-consumes cleanly.
        if (
          consumer.closed ||
          currentClient.getConsumer(consumer.producerId) !== consumer ||
          (plannedHandoff &&
            !currentClient.isConsumerHandoffActive(
              plannedHandoff.requestId,
              consumer,
            ))
        ) {
          try {
            consumer.close();
          } catch {}
          if (plannedHandoff) {
            currentClient.failConsumerHandoff(
              plannedHandoff.requestId,
              "Consumer displaced during setup",
              "displaced",
            );
          }
          respond(callback, {
            error: "Consumer displaced during setup",
            code: "displaced",
          });
          return;
        }

        emitConsumerTelemetry(telemetryTarget, "created");

        const displacedRetirements =
          currentClient.captureDisplacedConsumerRetirements(consumer);

        if (
          plannedHandoff &&
          !currentClient.completeConsumerHandoff(
            plannedHandoff.requestId,
            consumer,
          )
        ) {
          try {
            consumer.close();
          } catch {}
          respond(callback, {
            error: "Planned consumer handoff was aborted before acknowledgement",
            code: "aborted",
          });
          return;
        }

        respond(
          callback,
          buildConsumeResponse(consumer, plannedHandoff?.requestId),
        );

        for (const displacedGeneration of displacedRetirements) {
          setTimeout(() => {
            try {
              currentClient.retireDisplacedConsumer(displacedGeneration);
            } catch {}
          }, DISPLACED_CONSUMER_CLOSE_DELAY_MS).unref?.();
        }
      } catch (error) {
        if (ownedHandoff) {
          ownedHandoff.client.failConsumerHandoff(
            ownedHandoff.requestId,
            (error as Error).message,
          );
        }
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
          : context.currentRoom.getAllProducers(context.currentClient.id);
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
      callback: (
        response: { success: boolean } | { error: string; code?: string },
      ) => void,
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
            code: "rate_limited",
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
          respond(callback, { error: "Consumer not found", code: "not_found" });
          return;
        }
        if (!isCurrentConsumerGeneration(currentClient, consumer)) {
          respond(callback, {
            error: "Consumer generation displaced",
            code: "displaced",
          });
          return;
        }

        markConsumerClientPausedIntent(consumer, false);
        const wasPaused = consumer.paused;
        if (wasPaused) {
          await consumer.resume();
        }

        if (!isCurrentConsumerGeneration(currentClient, consumer)) {
          respond(callback, {
            error: "Consumer generation displaced",
            code: "displaced",
          });
          return;
        }

        if (
          shouldExplicitlyRequestConsumerKeyFrame({
            kind: consumer.kind,
            wasPaused,
            requested: data.requestKeyFrame === true,
          })
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

        if (!isCurrentConsumerGeneration(currentClient, consumer)) {
          respond(callback, {
            error: "Consumer generation displaced",
            code: "displaced",
          });
          return;
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
    "abortConsumerHandoff",
    (
      data: AbortConsumerHandoffData,
      callback: (
        response: AbortConsumerHandoffResponse | { error: string },
      ) => void,
    ) => {
      try {
        const currentClient = context.currentClient;
        if (!context.currentRoom || !currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        const producerId = normalizeMediaId(data?.producerId);
        const parsedHandoff = parsePlannedConsumerHandoff({
          requestId: data?.requestId,
          predecessorConsumerId: data?.predecessorConsumerId,
        });
        if (!producerId || !parsedHandoff.ok || !parsedHandoff.value) {
          respond(callback, { error: "Invalid planned consumer handoff abort" });
          return;
        }

        const handoff = parsedHandoff.value;
        const result = currentClient.abortConsumerHandoff({
          requestId: handoff.requestId,
          producerId,
          predecessorConsumerId: handoff.predecessorConsumerId,
        });
        if (!result.safe) {
          respond(callback, {
            error: "Planned consumer handoff predecessor was not safely restored",
          });
          return;
        }
        respond(callback, {
          success: true,
          requestId: handoff.requestId,
          status: result.status,
          ...(result.successorConsumerId
            ? { successorConsumerId: result.successorConsumerId }
            : {}),
          predecessorRestored: result.predecessorRestored,
        });
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

        respond(
          callback,
          await applyConsumerPreferencesData(room, currentClient, data),
        );
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "setConsumerPreferencesBatch",
    async (
      data: SetConsumerPreferencesBatchData,
      callback: (
        response: SetConsumerPreferencesBatchResponse | { error: string },
      ) => void,
    ) => {
      try {
        const room = context.currentRoom;
        const currentClient = context.currentClient;
        if (!room || !currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        if (
          !takeToken(
            socket,
            "setConsumerPreferencesBatch",
            RATE_LIMITS.consumerControlBatch,
          )
        ) {
          respond(callback, {
            error: "Too many consumer control requests; please retry shortly",
          });
          return;
        }

        const updates = Array.isArray(data?.updates) ? data.updates : [];
        if (
          updates.length === 0 ||
          updates.length > MAX_CONSUMER_PREFERENCE_BATCH_SIZE
        ) {
          respond(callback, {
            error: `Consumer preference batches must include 1-${MAX_CONSUMER_PREFERENCE_BATCH_SIZE} updates`,
          });
          return;
        }

        const results: SetConsumerPreferencesBatchResponse["results"] = [];
        for (const update of updates) {
          try {
            results.push(
              await applyConsumerPreferencesData(room, currentClient, update),
            );
          } catch (error) {
            results.push({
              error: (error as Error).message,
              consumerId:
                typeof update?.consumerId === "string"
                  ? update.consumerId
                  : undefined,
            });
          }
        }

        respond(callback, {
          success: true,
          results,
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

        context.currentRoom.refreshWebcamReceiverCapacityProof(
          videoProducer.id,
        );

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
