import type {
  CreateTransportResponse,
  ConnectTransportData,
  RestartIceData,
  RestartIceResponse,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerTransportHandlers = (context: ConnectionContext): void => {
  const { socket } = context;

  socket.on(
    "createProducerTransport",
    async (
      callback: (response: CreateTransportResponse | { error: string }) => void,
    ) => {
      try {
        if (!context.currentRoom || !context.currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot create producer transports",
          });
          return;
        }

        const transport = await context.currentRoom.createWebRtcTransport();
        const previousTransport = context.currentClient.producerTransport;
        if (previousTransport && previousTransport.id !== transport.id) {
          try {
            previousTransport.close();
          } catch {}
        }
        context.currentClient.producerTransport = transport;

        respond(callback, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates as any,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        Logger.error("Error creating producer transport:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "createConsumerTransport",
    async (
      callback: (response: CreateTransportResponse | { error: string }) => void,
    ) => {
      try {
        if (!context.currentRoom || !context.currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        const transport = await context.currentRoom.createWebRtcTransport();
        const previousTransport = context.currentClient.consumerTransport;
        if (previousTransport && previousTransport.id !== transport.id) {
          try {
            previousTransport.close();
          } catch {}
        }
        context.currentClient.consumerTransport = transport;

        respond(callback, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates as any,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        Logger.error("Error creating consumer transport:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "connectProducerTransport",
    async (
      data: ConnectTransportData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const producerTransport = context.currentClient?.producerTransport;
        if (!producerTransport) {
          if (context.currentClient?.isObserver) {
            respond(callback, {
              error: "Watch-only attendees cannot connect producer transports",
            });
            return;
          }
          respond(callback, { error: "Producer transport not found" });
          return;
        }

        if (
          data.transportId &&
          data.transportId.trim() &&
          producerTransport.id !== data.transportId
        ) {
          respond(callback, { error: "Stale producer transport" });
          return;
        }

        await producerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });

        respond(callback, { success: true });
      } catch (error) {
        Logger.error("Error connecting producer transport:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "connectConsumerTransport",
    async (
      data: ConnectTransportData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const consumerTransport = context.currentClient?.consumerTransport;
        if (!consumerTransport) {
          respond(callback, { error: "Consumer transport not found" });
          return;
        }

        if (
          data.transportId &&
          data.transportId.trim() &&
          consumerTransport.id !== data.transportId
        ) {
          respond(callback, { error: "Stale consumer transport" });
          return;
        }

        await consumerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });

        respond(callback, { success: true });
      } catch (error) {
        Logger.error("Error connecting consumer transport:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "restartIce",
    async (
      data: RestartIceData,
      callback: (response: RestartIceResponse | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        const transport =
          data.transport === "producer"
            ? context.currentClient.producerTransport
            : context.currentClient.consumerTransport;

        if (data.transport === "producer" && context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot restart producer ICE",
          });
          return;
        }

        if (!transport) {
          respond(callback, { error: "Transport not found" });
          return;
        }

        if (
          data.transportId &&
          data.transportId.trim() &&
          transport.id !== data.transportId
        ) {
          respond(callback, { error: "Stale transport" });
          return;
        }

        const iceParameters = await transport.restartIce();
        respond(callback, { iceParameters });
      } catch (error) {
        Logger.error("Error restarting ICE:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
