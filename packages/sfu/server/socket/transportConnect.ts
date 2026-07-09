import type { DtlsParameters, WebRtcTransport } from "mediasoup/types";

const pendingTransportConnects = new WeakMap<WebRtcTransport, Promise<void>>();

const isAlreadyConnectingState = (state: WebRtcTransport["dtlsState"]): boolean =>
  state === "connecting" || state === "connected";

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

  if (isAlreadyConnectingState(transport.dtlsState)) {
    return;
  }
  if (isTerminalConnectState(transport.dtlsState)) {
    throw new Error(`Transport DTLS state is ${transport.dtlsState}`);
  }

  const connectPromise = transport
    .connect({ dtlsParameters })
    .catch((error: unknown) => {
      if (isConnectAlreadyCalledError(error)) return;
      throw error;
    })
    .finally(() => {
      pendingTransportConnects.delete(transport);
    });
  pendingTransportConnects.set(transport, connectPromise);
  await connectPromise;
};
