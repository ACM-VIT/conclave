import type { DtlsParameters, WebRtcTransport } from "mediasoup/types";

const pendingTransportConnects = new WeakMap<WebRtcTransport, Promise<void>>();
const completedTransportConnects = new WeakSet<WebRtcTransport>();

const isTerminalConnectState = (state: WebRtcTransport["dtlsState"]): boolean =>
  state === "failed" || state === "closed";

const isConnectAlreadyCalledError = (error: unknown): boolean =>
  error instanceof Error && /connect\(\) already called/i.test(error.message);

export const connectWebRtcTransportOnce = async (
  transport: WebRtcTransport,
  dtlsParameters: DtlsParameters,
): Promise<void> => {
  if (transport.closed) {
    throw new Error("Transport is closed");
  }

  const pending = pendingTransportConnects.get(transport);
  if (pending) {
    await pending;
    return;
  }

  if (isTerminalConnectState(transport.dtlsState)) {
    throw new Error(`Transport DTLS state is ${transport.dtlsState}`);
  }
  // ICE can start DTLS before the signaling request supplies the peer's
  // fingerprint. "connecting" therefore does not prove connect() ran.
  if (completedTransportConnects.has(transport) || transport.dtlsState === "connected") {
    return;
  }

  const connectPromise = transport
    .connect({ dtlsParameters })
    .catch((error: unknown) => {
      if (isConnectAlreadyCalledError(error)) return;
      throw error;
    })
    .then(() => {
      completedTransportConnects.add(transport);
    })
    .finally(() => {
      pendingTransportConnects.delete(transport);
    });
  pendingTransportConnects.set(transport, connectPromise);
  await connectPromise;
};
