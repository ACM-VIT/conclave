import { SFU_EVENTS } from "@conclave/meeting-core/sfu-events";
import type { ProducerTransportNetworkProfileApplication } from "../hooks/useAdaptivePublishQuality";

export const PRODUCER_TRANSPORT_PROFILE_ACK_TIMEOUT_MS = 2_500;

type Application = ProducerTransportNetworkProfileApplication;
type ProfileAcknowledgement =
  | (Application & { success: true })
  | { error: string };

type ProfileSocket = {
  connected: boolean;
  io: { engine: object };
  emit(
    event: typeof SFU_EVENTS.clientToServer.setProducerTransportNetworkProfile,
    payload: Pick<Application, "transportId" | "profile">,
    acknowledge: (response: ProfileAcknowledgement) => void,
  ): void;
};

export function createProducerTransportNetworkProfileSetter(
  socketRef: { readonly current: ProfileSocket | null },
  transportRef: { readonly current: { id: string; closed: boolean } | null },
) {
  let acknowledgedProfile: { connection: object; application: Application } | null = null;

  return (
    profile: Application["profile"],
  ): Promise<Application> => {
    const socket = socketRef.current;
    const transport = transportRef.current;
    if (!socket?.connected) {
      return Promise.reject(new Error("Socket not connected"));
    }
    if (!transport || transport.closed) {
      return Promise.reject(new Error("Producer transport not found"));
    }
    const transportId = transport.id;
    const connection = socket.io.engine;
    const acknowledged = acknowledgedProfile;
    if (
      acknowledged &&
      acknowledged.connection === connection &&
      acknowledged.application.transportId === transportId &&
      acknowledged.application.profile === profile
    ) {
      return Promise.resolve(acknowledged.application);
    }
    // An unanswered change may already have reached the SFU.
    acknowledgedProfile = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Producer transport profile acknowledgement timed out"));
      }, PRODUCER_TRANSPORT_PROFILE_ACK_TIMEOUT_MS);
      const settle = (response: ProfileAcknowledgement) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        if ("error" in response) {
          reject(new Error(response.error));
          return;
        }
        const application = {
          transportId: response.transportId,
          profile: response.profile,
          maxIncomingBitrate: response.maxIncomingBitrate,
        };
        if (
          application.transportId === transportId &&
          application.profile === profile &&
          Number.isFinite(application.maxIncomingBitrate) &&
          application.maxIncomingBitrate > 0
        ) {
          acknowledgedProfile = { connection, application };
        }
        resolve(application);
      };

      try {
        socket.emit(
          SFU_EVENTS.clientToServer.setProducerTransportNetworkProfile,
          { transportId, profile },
          settle,
        );
      } catch (error) {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
}
