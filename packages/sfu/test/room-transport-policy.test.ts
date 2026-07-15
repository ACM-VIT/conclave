import { describe, expect, it, vi } from "vitest";
import type {
  Router,
  WebRtcTransport,
  WebRtcTransportOptions,
} from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import {
  DEFAULT_PRODUCER_MAX_INCOMING_BITRATE_BPS,
  config,
  resolveWebRtcTransportProtocolPolicy,
} from "../config/config.js";

const makeRoomHarness = () => {
  const setMaxIncomingBitrate = vi.fn(async (_bitrate: number) => {});
  const transport = {
    id: "transport-id",
    setMaxIncomingBitrate,
  } as unknown as WebRtcTransport;
  const createWebRtcTransport = vi.fn(
    async (_options: WebRtcTransportOptions) => transport,
  );
  const router = { createWebRtcTransport } as unknown as Router;
  const room = new Room({
    id: "room-id",
    router,
    clientId: "client-id",
    workerPid: null,
  });

  return {
    createWebRtcTransport,
    room,
    setMaxIncomingBitrate,
  };
};

describe("Room WebRTC transport policy", () => {
  it("defaults to UDP-preferred fallback and supports UDP-only proof runs", () => {
    expect(resolveWebRtcTransportProtocolPolicy({})).toEqual({
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    expect(
      resolveWebRtcTransportProtocolPolicy({
        SFU_WEBRTC_ENABLE_TCP: "0",
      }),
    ).toEqual({
      enableUdp: true,
      enableTcp: false,
      preferUdp: true,
    });
    expect(() =>
      resolveWebRtcTransportProtocolPolicy({
        SFU_WEBRTC_ENABLE_UDP: "false",
        SFU_WEBRTC_ENABLE_TCP: "false",
      }),
    ).toThrow(/At least one/);
  });

  it("passes the configured protocol policy to mediasoup", async () => {
    const harness = makeRoomHarness();

    await harness.room.createWebRtcTransport("consumer");

    expect(harness.createWebRtcTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        enableUdp: config.webRtcTransport.enableUdp,
        enableTcp: config.webRtcTransport.enableTcp,
        preferUdp: config.webRtcTransport.preferUdp,
      }),
    );
  });

  it("applies the upload ceiling only to producer transports", async () => {
    const harness = makeRoomHarness();

    await harness.room.createWebRtcTransport("producer");

    expect(harness.createWebRtcTransport).toHaveBeenCalledWith(
      expect.objectContaining({ appData: { role: "producer" } }),
    );
    const options = harness.createWebRtcTransport.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("initialAvailableOutgoingBitrate");
    expect(harness.setMaxIncomingBitrate).toHaveBeenCalledOnce();
    expect(harness.setMaxIncomingBitrate).toHaveBeenCalledWith(
      config.webRtcTransport.producerMaxIncomingBitrate,
    );
  });

  it("seeds outgoing BWE only on consumer transports", async () => {
    const harness = makeRoomHarness();

    await harness.room.createWebRtcTransport("consumer");

    expect(harness.createWebRtcTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        appData: { role: "consumer" },
        initialAvailableOutgoingBitrate:
          config.webRtcTransport.initialAvailableOutgoingBitrate,
      }),
    );
    expect(harness.setMaxIncomingBitrate).not.toHaveBeenCalled();
  });

  it("keeps enough default upload headroom for the current publish profile", () => {
    const currentMaxPublishMediaBitrateBps =
      1_850_000 + 2_500_000 + 96_000 + 96_000;

    expect(DEFAULT_PRODUCER_MAX_INCOMING_BITRATE_BPS).toBe(6_000_000);
    expect(DEFAULT_PRODUCER_MAX_INCOMING_BITRATE_BPS).toBeGreaterThan(
      currentMaxPublishMediaBitrateBps * 1.2,
    );
  });
});
