import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Producer, RtpParameters, WebRtcTransport } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const vp9RtpParameters = {
  codecs: [
    {
      mimeType: "video/VP9",
      payloadType: 101,
      clockRate: 90_000,
      parameters: { "profile-id": 0 },
      rtcpFeedback: [],
    },
  ],
  encodings: [{ scalabilityMode: "L2T1" }],
  headerExtensions: [],
  rtcp: {},
} satisfies RtpParameters;

const vp8SingleRtpParameters = {
  codecs: [
    {
      mimeType: "video/VP8",
      payloadType: 100,
      clockRate: 90_000,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: 1 }],
  headerExtensions: [],
  rtcp: {},
} satisfies RtpParameters;

describe("media producer codec-policy fencing", () => {
  it("closes a deferred webcam producer when room policy changes during transport.produce", async () => {
    const handlers = new Map<string, SocketHandler>();
    const socket = {
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return socket;
      }),
    } as unknown as Socket;

    let selectedMimeType = "video/VP9";
    const rtpParametersMatchCurrentWebcamCodecPolicy = vi.fn(
      (rtpParameters: RtpParameters) =>
        rtpParameters.codecs[0]?.mimeType === selectedMimeType,
    );
    const room = {
      rtpParametersMatchCurrentWebcamCodecPolicy,
      webcamCodecPolicy: {
        mimeType: "video/VP9",
        scalabilityMode: "L2T1",
      },
    } as unknown as Room;

    let resolveProduce!: (producer: Producer) => void;
    const deferredProducer = new Promise<Producer>((resolve) => {
      resolveProduce = resolve;
    });
    const produce = vi.fn(() => deferredProducer);
    const producerTransport = {
      id: "send-transport",
      produce,
    } as unknown as WebRtcTransport;
    const addProducer = vi.fn();
    const currentClient = {
      id: "publisher",
      isObserver: false,
      producerTransport,
      addProducer,
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

    const produceHandler = handlers.get("produce") as unknown as (
      data: {
        transportId: string;
        kind: "video";
        rtpParameters: RtpParameters;
        appData: { type: "webcam" };
      },
      callback: (response: { producerId?: string; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();
    const pendingRequest = produceHandler(
      {
        transportId: "send-transport",
        kind: "video",
        rtpParameters: vp9RtpParameters,
        appData: { type: "webcam" },
      },
      callback,
    );

    expect(produce).toHaveBeenCalledTimes(1);
    expect(rtpParametersMatchCurrentWebcamCodecPolicy).toHaveBeenCalledTimes(1);

    selectedMimeType = "video/VP8";
    const close = vi.fn();
    resolveProduce({
      id: "late-vp9-producer",
      rtpParameters: vp9RtpParameters,
      close,
    } as unknown as Producer);
    await pendingRequest;

    expect(rtpParametersMatchCurrentWebcamCodecPolicy).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(addProducer).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      error: "Webcam codec policy changed during producer creation",
    });
  });

  it("reserves before async produce and advertises the exact successor before closing its predecessor", async () => {
    const handlers = new Map<string, SocketHandler>();
    const order: string[] = [];
    const publisherSocket = {
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return publisherSocket;
      }),
      to: vi.fn(),
      emit: vi.fn(),
    } as unknown as Socket;
    const receiverSocket = {
      emit: vi.fn((event: string) => {
        if (event === "newProducer") order.push("newProducer");
      }),
    } as unknown as Socket;

    let resolveProduce!: (producer: Producer) => void;
    const deferredProducer = new Promise<Producer>((resolve) => {
      resolveProduce = resolve;
    });
    const produce = vi.fn(() => deferredProducer);
    const producerTransport = {
      id: "send-transport",
      produce,
    } as unknown as WebRtcTransport;
    const predecessor = {
      id: "predecessor",
      closed: false,
      close: vi.fn(() => order.push("closePredecessor")),
    } as unknown as Producer;
    const reservation = {
      nonce: "nonce_nonce_nonce_nonce_4",
      predecessorProducerId: predecessor.id,
      predecessorGeneration: 1,
      ownerClientId: "publisher",
      ownerSocketId: "publisher-socket",
      producerTransportId: producerTransport.id,
      expiresAt: Date.now() + 5_000,
    };
    const reserveWebcamReceiverCapacityTransition = vi
      .fn()
      .mockReturnValue(reservation);
    const commitWebcamReceiverCapacityTransition = vi
      .fn()
      .mockReturnValue(predecessor);
    const refreshWebcamReceiverCapacityProof = vi.fn();
    const currentClient = {
      id: "publisher",
      isObserver: false,
      isWebinarAttendee: false,
      producerTransport,
      socket: publisherSocket,
    } as unknown as Client;
    const receiver = {
      id: "receiver",
      isWebinarAttendee: false,
      socket: receiverSocket,
    } as unknown as Client;
    const room = {
      id: "room",
      channelId: "instance:room",
      clients: new Map([
        ["publisher", currentClient],
        ["receiver", receiver],
      ]),
      screenShareProducerId: null,
      webcamCodecPolicy: { mimeType: "video/VP8" },
      rtpParametersMatchCurrentWebcamCodecPolicy: vi.fn().mockReturnValue(true),
      reserveWebcamReceiverCapacityTransition,
      commitWebcamReceiverCapacityTransition,
      cancelWebcamReceiverCapacityTransition: vi.fn(),
      registerWebinarAudioProducer: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue(currentClient),
      getProducerInfoById: vi.fn().mockReturnValue({ producerId: "successor" }),
      refreshWebcamReceiverCapacityProof,
    } as unknown as Room;
    const state = {
      rooms: new Map([[room.channelId, room]]),
      webinarConfigs: new Map(),
    } as unknown as SfuState;

    registerMediaHandlers({
      socket: publisherSocket,
      io: {} as ConnectionContext["io"],
      state,
      currentRoom: room,
      currentClient,
      pendingRoomId: null,
      pendingRoomChannelId: null,
      pendingUserKey: null,
      currentUserKey: null,
      activeConclaveAnswers: new Map(),
      adminHandlersRegistered: false,
    });

    const produceHandler = handlers.get("produce") as unknown as (
      data: {
        transportId: string;
        kind: "video";
        rtpParameters: RtpParameters;
        appData: {
          type: "webcam";
          webcamReceiverCapacityTransition: {
            fromProducerId: string;
            nonce: string;
          };
        };
      },
      callback: (response: { producerId?: string; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();
    const pendingRequest = produceHandler(
      {
        transportId: producerTransport.id,
        kind: "video",
        rtpParameters: vp8SingleRtpParameters,
        appData: {
          type: "webcam",
          webcamReceiverCapacityTransition: {
            fromProducerId: predecessor.id,
            nonce: reservation.nonce,
          },
        },
      },
      callback,
    );
    expect(reserveWebcamReceiverCapacityTransition).toHaveBeenCalledOnce();
    expect(produce).toHaveBeenCalledOnce();
    expect(commitWebcamReceiverCapacityTransition).not.toHaveBeenCalled();

    const producerEvents = new EventEmitter();
    const producerObserver = new EventEmitter();
    const successor = {
      id: "successor",
      closed: false,
      paused: false,
      rtpParameters: vp8SingleRtpParameters,
      on: producerEvents.on.bind(producerEvents),
      observer: producerObserver,
      close: vi.fn(),
    } as unknown as Producer;
    resolveProduce(successor);
    await pendingRequest;

    expect(commitWebcamReceiverCapacityTransition).toHaveBeenCalledWith(
      currentClient.id,
      successor,
      reservation,
    );
    expect(order).toEqual(["newProducer", "closePredecessor"]);
    expect(callback).toHaveBeenCalledWith({ producerId: successor.id });
  });
});
