import type {
  ConsumeData,
  ConsumeResponse,
  ProduceData,
  ProduceResponse,
  ProducerInfo,
  ToggleMediaData,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { ensureProducerTranscriber } from "../../recording/roomTranscriber.js";
import { emitWebinarFeedChanged } from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

const DEFAULT_LOCAL_VOSK_WS_URL = "ws://127.0.0.1:2800";

export const registerMediaHandlers = (context: ConnectionContext): void => {
  const { socket, state, io } = context;

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

        const { kind, rtpParameters, appData } = data;
        const type = (appData.type as "webcam" | "screen") || "webcam";
        const paused = !!appData.paused;

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

        if (kind === "audio" && type === "webcam") {
          const channelId = room.channelId;
          const speakerLabel =
            room.getDisplayNameForUser(currentClient.id) || currentClient.id;
          const sttUrl =
            process.env.STT_WS_URL ||
            process.env.VOSK_WS_URL ||
            (process.env.NODE_ENV === "production"
              ? ""
              : DEFAULT_LOCAL_VOSK_WS_URL);
          if (!sttUrl) {
            Logger.warn(
              `Skipping transcriber start for channel=${channelId} producer=${producer.id}: STT URL is not configured`,
            );
          } else {
            const transcriber = ensureProducerTranscriber(
              channelId,
              producer.id,
              room.router,
            );
            Logger.info(
              `Starting room transcriber for channel=${channelId} producer=${producer.id} stt=${sttUrl}`,
            );
            void transcriber.start(producer, {
              sttUrl,
              sttHeaders: process.env.STT_API_KEY
                ? { Authorization: `Bearer ${process.env.STT_API_KEY}` }
                : undefined,
              speakerLabel,
            });
          }
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

          if (producerAdvertised) {
            for (const [targetClientId, targetClient] of activeRoom.clients) {
              if (targetClientId === clientId || targetClient.isWebinarAttendee) {
                continue;
              }
              targetClient.socket.emit("producerClosed", {
                producerId: producer.id,
                producerUserId: clientId,
              });
            }
          }

          emitWebinarFeedChanged(io, state, activeRoom);
        };

        producer.on("transportclose", notifyProducerClosed);
        producer.observer.on("close", notifyProducerClosed);

        if (isScreenShareVideo) {
          room.setScreenShareProducer(producer.id);
        }

        currentClient.addProducer(producer);
        await room.registerWebinarAudioProducer(
          currentClient.id,
          producer,
          type,
        );

        const activeRoom = state.rooms.get(roomChannelId);
        const activeClient = activeRoom?.getClient(clientId);
        const producerStillActive = Boolean(
          activeClient?.getProducerInfos().some((info) => info.producerId === producer.id),
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
          });
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
        if (!context.currentRoom || !context.currentClient?.consumerTransport) {
          respond(callback, { error: "Not ready to consume" });
          return;
        }

        const { producerId, rtpCapabilities } = data;

        if (!context.currentRoom.canConsume(producerId, rtpCapabilities)) {
          respond(callback, { error: "Cannot consume this producer" });
          return;
        }

        const consumer = await context.currentClient.consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        context.currentClient.addConsumer(consumer);

        consumer.on("transportclose", () => {
          Logger.info(`Consumer transport closed: ${consumer.id}`);
        });

        consumer.on("producerclose", () => {
          Logger.info(`Producer closed for consumer: ${consumer.id}`);
          socket.emit("producerClosed", { producerId });
        });

        respond(callback, {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
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
      data: { consumerId: string },
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        for (const consumer of context.currentClient.consumers.values()) {
          if (consumer.id === data.consumerId) {
            await consumer.resume();
            respond(callback, { success: true });
            return;
          }
        }

        respond(callback, { error: "Consumer not found" });
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
        const removed = context.currentClient.removeProducerById(
          data.producerId,
        );
        if (removed) {
          if (removed.type === "screen") {
            context.currentRoom.clearScreenShareProducer(data.producerId);
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
              producerId: data.producerId,
              producerUserId: context.currentClient.id,
            });
          }
          emitWebinarFeedChanged(io, state, context.currentRoom);

          respond(callback, { success: true });
          return;
        }

        if (context.currentRoom.screenShareProducerId === data.producerId) {
          context.currentRoom.clearScreenShareProducer(data.producerId);
          emitWebinarFeedChanged(io, state, context.currentRoom);
        }

        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
