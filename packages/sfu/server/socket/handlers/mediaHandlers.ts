import type {
  ConsumeData,
  ConsumeResponse,
  ProduceData,
  ProduceResponse,
  ProducerInfo,
  ToggleMediaData,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { emitWebinarFeedChanged } from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerMediaHandlers = (context: ConnectionContext): void => {
  const { socket, state, io } = context;

  socket.on(
    "produce",
    async (
      data: ProduceData,
      callback: (response: ProduceResponse | { error: string }) => void,
    ) => {
      try {
        if (!context.currentRoom || !context.currentClient?.producerTransport) {
          respond(callback, { error: "Not ready to produce" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot produce media",
          });
          return;
        }

        const { kind, rtpParameters, appData } = data;
        const type = (appData.type as "webcam" | "screen") || "webcam";
        const paused = !!appData.paused;

        if (type === "screen") {
          const existingScreenShare = context.currentRoom.screenShareProducerId;
          if (existingScreenShare) {
            respond(callback, { error: "Screen is already being shared" });
            return;
          }
        }

        const producer = await context.currentClient.producerTransport.produce({
          kind,
          rtpParameters,
          appData: { type },
          paused,
        });

        if (type === "screen") {
          context.currentRoom.setScreenShareProducer(producer.id);
        }

        context.currentClient.addProducer(producer);

        for (const [clientId, client] of context.currentRoom.clients) {
          if (clientId === context.currentClient.id || client.isWebinarAttendee) {
            continue;
          }
          client.socket.emit("newProducer", {
            producerId: producer.id,
            producerUserId: context.currentClient.id,
            kind,
            type,
            paused: producer.paused,
          });
        }
        emitWebinarFeedChanged(io, context.currentRoom);

        const roomChannelId = context.currentRoom.channelId;
        const clientId = context.currentClient.id;

        let producerClosed = false;
        const notifyProducerClosed = () => {
          if (producerClosed) return;
          producerClosed = true;

          Logger.info(`Producer closed: ${producer.id}`);
          const room = state.rooms.get(roomChannelId);
          if (!room) return;

          if (type === "screen") {
            room.clearScreenShareProducer(producer.id);
          }

          for (const [targetClientId, targetClient] of room.clients) {
            if (targetClientId === clientId || targetClient.isWebinarAttendee) {
              continue;
            }
            targetClient.socket.emit("producerClosed", {
              producerId: producer.id,
              producerUserId: clientId,
            });
          }
          emitWebinarFeedChanged(io, room);
        };

        producer.on("transportclose", notifyProducerClosed);
        producer.observer.on("close", notifyProducerClosed);

        Logger.info(
          `User ${context.currentClient.id} started producing ${kind} (${type}): ${producer.id}`,
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
        emitWebinarFeedChanged(io, context.currentRoom);

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
        emitWebinarFeedChanged(io, context.currentRoom);

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
          emitWebinarFeedChanged(io, context.currentRoom);

          respond(callback, { success: true });
          return;
        }

        if (context.currentRoom.screenShareProducerId === data.producerId) {
          context.currentRoom.clearScreenShareProducer(data.producerId);
          emitWebinarFeedChanged(io, context.currentRoom);
        }

        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
