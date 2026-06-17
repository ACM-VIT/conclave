import type {
  CreateTransportResponse,
  ConnectTransportData,
  RestartIceData,
  RestartIceResponse,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

const MAX_TRANSPORT_ID_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeTransportId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_TRANSPORT_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

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

        // Throttle transport allocation (roughly once per kind, small retry burst).
        if (
          !takeToken(
            socket,
            "createProducerTransport",
            RATE_LIMITS.transportCreate,
          )
        ) {
          respond(callback, {
            error: "Too many transport requests; please retry shortly",
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
          iceCandidates: transport.iceCandidates,
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

        // Throttle transport allocation (roughly once per kind, small retry burst).
        if (
          !takeToken(
            socket,
            "createConsumerTransport",
            RATE_LIMITS.transportCreate,
          )
        ) {
          respond(callback, {
            error: "Too many transport requests; please retry shortly",
          });
          return;
        }

        const transport = await context.currentRoom.createWebRtcTransport();
        const previousTransport = context.currentClient.consumerTransport;
        if (previousTransport && previousTransport.id !== transport.id) {
          context.currentClient.closeConsumers();
          try {
            previousTransport.close();
          } catch {}
        }
        context.currentClient.consumerTransport = transport;

        respond(callback, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
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

        const transportId = normalizeTransportId(data?.transportId);
        if (data?.transportId !== undefined && !transportId) {
          respond(callback, { error: "Invalid transport ID" });
          return;
        }
        if (transportId && producerTransport.id !== transportId) {
          respond(callback, { error: "Stale producer transport" });
          return;
        }
        if (!isRecord(data?.dtlsParameters)) {
          respond(callback, { error: "Invalid DTLS parameters" });
          return;
        }

        if (producerTransport.closed) {
          respond(callback, { error: "Producer transport is closed" });
          return;
        }
        if (producerTransport.dtlsState === "connected") {
          respond(callback, { success: true });
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

        const transportId = normalizeTransportId(data?.transportId);
        if (data?.transportId !== undefined && !transportId) {
          respond(callback, { error: "Invalid transport ID" });
          return;
        }
        if (transportId && consumerTransport.id !== transportId) {
          respond(callback, { error: "Stale consumer transport" });
          return;
        }
        if (!isRecord(data?.dtlsParameters)) {
          respond(callback, { error: "Invalid DTLS parameters" });
          return;
        }

        if (consumerTransport.closed) {
          respond(callback, { error: "Consumer transport is closed" });
          return;
        }
        if (consumerTransport.dtlsState === "connected") {
          respond(callback, { success: true });
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

        if (data?.transport !== "producer" && data?.transport !== "consumer") {
          respond(callback, { error: "Invalid transport" });
          return;
        }

        if (!takeToken(socket, "restartIce", RATE_LIMITS.iceRestart)) {
          respond(callback, {
            error: "Too many ICE restart requests; please retry shortly",
          });
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
        if (transport.closed) {
          respond(callback, { error: "Transport is closed" });
          return;
        }

        const transportId = normalizeTransportId(data?.transportId);
        if (data?.transportId !== undefined && !transportId) {
          respond(callback, { error: "Invalid transport ID" });
          return;
        }
        if (transportId && transport.id !== transportId) {
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
