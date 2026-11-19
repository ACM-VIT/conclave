import { describe, expect, it, vi } from "vitest";
import type { Producer, RtpParameters, WebRtcTransport } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const screenRtpParameters = {
  codecs: [
    { mimeType: "video/VP8", payloadType: 100, clockRate: 90_000, parameters: {}, rtcpFeedback: [] },
  ],
  encodings: [{ ssrc: 1 }],
  headerExtensions: [],
  rtcp: {},
} satisfies RtpParameters;

describe("screen share ownership across the produce await", () => {
  it("refuses a share when another participant claimed the slot while this one was being created", async () => {
    const handlers = new Map<string, SocketHandler>();
    const socket = {
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return socket;
      }),
    } as unknown as Socket;

    let screenShareProducerId: string | null = null;
    const setScreenShareProducer = vi.fn((id: string) => { screenShareProducerId = id; });
    const room = {
      get screenShareProducerId() { return screenShareProducerId; },
      getProducerInfoById: (id: string) =>
        id === "other-share" ? { producerUserId: "other-user" } : null,
      setScreenShareProducer,
      clearScreenShareProducer: vi.fn(),
      rtpParametersMatchCurrentWebcamCodecPolicy: () => true,
      webcamCodecPolicy: { mimeType: "video/VP8", scalabilityMode: null },
    } as unknown as Room;

    let resolveProduce!: (producer: Producer) => void;
    const produce = vi.fn(() => new Promise<Producer>((resolve) => { resolveProduce = resolve; }));
    const addProducer = vi.fn();
    const currentClient = {
      id: "sharer",
      isObserver: false,
      producerTransport: { id: "send-transport", produce } as unknown as WebRtcTransport,
      addProducer,
      getProducer: vi.fn(() => undefined),
    } as unknown as Client;

    registerMediaHandlers({
      socket,
      io: {} as ConnectionContext["io"],
      state: { rooms: new Map() } as unknown as SfuState,
      currentRoom: room,
      currentClient,
      pendingRoomId: null,
      pendingRoomChannelId: null,
      pendingUserKey: null,
      currentUserKey: null,
      activeConclaveAnswers: new Map(),
      adminHandlersRegistered: false,
    });

    const callback = vi.fn();
    const pending = (handlers.get("produce") as unknown as (
      data: unknown,
      cb: (response: unknown) => void,
    ) => Promise<void>)(
      {
        transportId: "send-transport",
        kind: "video",
        rtpParameters: screenRtpParameters,
        appData: { type: "screen" },
      },
      callback,
    );
    expect(produce).toHaveBeenCalledOnce();

    // Another participant's share lands while this producer is being created.
    screenShareProducerId = "other-share";
    const close = vi.fn();
    resolveProduce({ id: "late-share", rtpParameters: screenRtpParameters, close } as unknown as Producer);
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(setScreenShareProducer).not.toHaveBeenCalled();
    expect(addProducer).not.toHaveBeenCalled();
    expect(screenShareProducerId).toBe("other-share");
    expect(callback).toHaveBeenCalledWith({ error: "Screen is already being shared" });
  });
});
