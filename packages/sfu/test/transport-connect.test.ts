import { describe, expect, it } from "vitest";
import type { DtlsParameters, WebRtcTransport } from "mediasoup/types";
import { connectWebRtcTransportOnce } from "../server/socket/transportConnect.js";

const dtlsParameters = {
  fingerprints: [],
  role: "auto",
} as DtlsParameters;

class FakeWebRtcTransport {
  closed = false;
  dtlsState: WebRtcTransport["dtlsState"] = "new";
  connectCalls = 0;
  connectImplementation: () => Promise<void> = async () => {};

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.connectImplementation();
  }
}

const asTransport = (transport: FakeWebRtcTransport): WebRtcTransport =>
  transport as unknown as WebRtcTransport;

describe("connectWebRtcTransportOnce", () => {
  it("coalesces overlapping connect calls for the same transport", async () => {
    const transport = new FakeWebRtcTransport();
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    transport.connectImplementation = () => pendingConnect;

    const first = connectWebRtcTransportOnce(
      asTransport(transport),
      dtlsParameters,
    );
    const second = connectWebRtcTransportOnce(
      asTransport(transport),
      dtlsParameters,
    );

    expect(transport.connectCalls).toBe(1);
    resolveConnect();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(transport.connectCalls).toBe(1);
  });

  it("treats connecting and connected transports as already connected", async () => {
    const transport = new FakeWebRtcTransport();
    transport.dtlsState = "connecting";

    await expect(
      connectWebRtcTransportOnce(asTransport(transport), dtlsParameters),
    ).resolves.toBeUndefined();
    expect(transport.connectCalls).toBe(0);

    transport.dtlsState = "connected";
    await expect(
      connectWebRtcTransportOnce(asTransport(transport), dtlsParameters),
    ).resolves.toBeUndefined();
    expect(transport.connectCalls).toBe(0);
  });

  it("treats mediasoup duplicate connect errors as idempotent success", async () => {
    const transport = new FakeWebRtcTransport();
    transport.connectImplementation = async () => {
      throw new Error(
        "connect() already called [method:webRtcTransport.connect]",
      );
    };

    await expect(
      connectWebRtcTransportOnce(asTransport(transport), dtlsParameters),
    ).resolves.toBeUndefined();
    expect(transport.connectCalls).toBe(1);
  });

  it("rejects failed transports", async () => {
    const transport = new FakeWebRtcTransport();
    transport.dtlsState = "failed";

    await expect(
      connectWebRtcTransportOnce(asTransport(transport), dtlsParameters),
    ).rejects.toThrow("Transport DTLS state is failed");
    expect(transport.connectCalls).toBe(0);
  });
});
