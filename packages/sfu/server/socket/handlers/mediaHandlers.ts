import type {
  ConsumeData,
  ConsumeResponse,
  ProduceData,
  ProduceResponse,
  ProducerInfo,
  ToggleMediaData,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { ensureRoomTranscriber } from "../../recording/roomTranscriber.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerMediaHandlers = (context: ConnectionContext): void => {
  const { socket, state } = context;

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
        if (context.currentClient.isGhost) {
          respond(callback, { error: "Ghost mode cannot produce media" });
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

        if (kind === "audio" && type === "webcam") {
          const channelId = context.currentRoom.channelId;
          const transcriber = ensureRoomTranscriber(
            channelId,
            context.currentRoom.router,
          );
          void transcriber.start(producer, {
            sttUrl: process.env.STT_WS_URL || "",
            sttHeaders: process.env.STT_API_KEY
              ? { Authorization: `Bearer ${process.env.STT_API_KEY}` }
              : undefined,
          });
        }

        if (type === "screen") {
          context.currentRoom.setScreenShareProducer(producer.id);
        }

        context.currentClient.addProducer(producer);

        socket.to(context.currentRoom.channelId).emit("newProducer", {
          producerId: producer.id,
          producerUserId: context.currentClient.id,
          kind,
          type,
          paused: producer.paused,
        });

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

          socket.to(roomChannelId).emit("producerClosed", {
            producerId: producer.id,
            producerUserId: clientId,
          });
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

        const producers = context.currentRoom.getAllProducers(
          context.currentClient.id,
        );
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
        if (context.currentClient.isGhost) {
          respond(callback, { error: "Ghost mode cannot unmute" });
          return;
        }

        await context.currentClient.toggleMute(data.paused);

        socket.to(context.currentRoom.channelId).emit("participantMuted", {
          userId: context.currentClient.id,
          muted: data.paused,
        });

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
        if (context.currentClient.isGhost) {
          respond(callback, { error: "Ghost mode cannot enable camera" });
          return;
        }

        await context.currentClient.toggleCamera(data.paused);

        socket.to(context.currentRoom.channelId).emit("participantCameraOff", {
          userId: context.currentClient.id,
          cameraOff: data.paused,
        });

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
        const removed = context.currentClient.removeProducerById(
          data.producerId,
        );
        if (removed) {
          if (removed.type === "screen") {
            context.currentRoom.clearScreenShareProducer(data.producerId);
          }

          socket.to(context.currentRoom.channelId).emit("producerClosed", {
            producerId: data.producerId,
            producerUserId: context.currentClient.id,
          });

          respond(callback, { success: true });
          return;
        }

        respond(callback, { error: "Producer not found" });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
