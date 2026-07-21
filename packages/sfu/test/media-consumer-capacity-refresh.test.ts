import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Consumer, WebRtcTransport } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

describe("media consumer capacity proof refresh", () => {
  it("refreshes live proof state for consumer media and close events", async () => {
    const handlers = new Map<string, SocketHandler>();
    const socket = {
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return socket;
      }),
      emit: vi.fn(),
    } as unknown as Socket;

    const events = new EventEmitter();
    const observer = new EventEmitter();
    const consumer = {
      id: "consumer",
      producerId: "producer",
      kind: "video",
      type: "simulcast",
      closed: false,
      paused: true,
      producerPaused: false,
      priority: 100,
      score: { score: 10, producerScore: 10, producerScores: [10, 10, 10] },
      preferredLayers: undefined,
      currentLayers: { spatialLayer: 2, temporalLayer: 2 },
      rtpParameters: { codecs: [], encodings: [] },
      appData: {},
      on: events.on.bind(events),
      observer,
      setPriority: vi.fn().mockResolvedValue(undefined),
      requestKeyFrame: vi.fn().mockResolvedValue(undefined),
    } as unknown as Consumer;

    const consume = vi.fn().mockResolvedValue(consumer);
    const refreshWebcamReceiverCapacityProof = vi.fn();
    const room = {
      id: "room",
      currentQuality: "standard",
      getProducerInfoById: vi.fn().mockReturnValue({
        producerId: "producer",
        producerUserId: "owner",
        kind: "video",
        type: "webcam",
        paused: false,
      }),
      producerIdMatchesCurrentWebcamCodecPolicy: vi.fn().mockReturnValue(true),
      canConsume: vi.fn().mockReturnValue(true),
      refreshWebcamReceiverCapacityProof,
    } as unknown as Room;
    const updateConsumerTelemetry = vi.fn().mockImplementation(() => ({
      consumerId: consumer.id,
      producerId: consumer.producerId,
      producerUserId: "owner",
      kind: consumer.kind,
      type: "webcam",
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
      priority: consumer.priority,
      score: consumer.score,
      preferredLayers: consumer.preferredLayers,
      currentLayers: consumer.currentLayers,
      createdAt: 0,
      updatedAt: 0,
    }));
    const currentClient = {
      id: "receiver",
      isWebinarAttendee: false,
      consumerTransport: {
        id: "recv-transport",
        consume,
      } as unknown as WebRtcTransport,
      addConsumer: vi.fn().mockReturnValue(null),
      getConsumer: vi.fn().mockReturnValue(consumer),
      getConsumerById: vi.fn().mockReturnValue(consumer),
      captureDisplacedConsumerRetirements: vi.fn().mockReturnValue([]),
      updateConsumerTelemetry,
      socket,
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

    const consumeHandler = handlers.get("consume") as unknown as (
      data: {
        transportId: string;
        producerId: string;
        rtpCapabilities: Record<string, unknown>;
      },
      callback: (response: { id?: string; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();
    await consumeHandler(
      {
        transportId: "recv-transport",
        producerId: "producer",
        rtpCapabilities: {},
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        id: consumer.id,
        consumerType: "simulcast",
      }),
    );

    refreshWebcamReceiverCapacityProof.mockClear();
    events.emit("score");
    events.emit("layerschange");
    events.emit("producerpause");
    events.emit("producerresume");
    observer.emit("pause");
    observer.emit("resume");
    events.emit("transportclose");
    observer.emit("close");

    expect(refreshWebcamReceiverCapacityProof).toHaveBeenCalledTimes(8);
    expect(refreshWebcamReceiverCapacityProof).toHaveBeenCalledWith(
      "producer",
    );
  });

  it("refreshes proof immediately when camera publication is paused", async () => {
    const handlers = new Map<string, SocketHandler>();
    const roomBroadcast = { emit: vi.fn() };
    const socket = {
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return socket;
      }),
      to: vi.fn().mockReturnValue(roomBroadcast),
    } as unknown as Socket;
    const producer = {
      id: "producer",
      paused: false,
      pause: vi.fn(async () => {
        producer.paused = true;
      }),
      resume: vi.fn(async () => {
        producer.paused = false;
      }),
    };
    const refreshWebcamReceiverCapacityProof = vi.fn();
    const room = {
      id: "room",
      channelId: "instance:room",
      refreshWebcamReceiverCapacityProof,
    } as unknown as Room;
    const currentClient = {
      id: "owner",
      isObserver: false,
      isCameraOff: false,
      getProducer: vi.fn().mockReturnValue(producer),
    } as unknown as Client;

    registerMediaHandlers({
      socket,
      io: {} as ConnectionContext["io"],
      state: {
        rooms: new Map(),
        webinarConfigs: new Map(),
      } as unknown as SfuState,
      currentRoom: room,
      currentClient,
      pendingRoomId: null,
      pendingRoomChannelId: null,
      pendingUserKey: null,
      currentUserKey: null,
      activeConclaveAnswers: new Map(),
      adminHandlersRegistered: false,
    });

    const toggleCameraHandler = handlers.get("toggleCamera") as unknown as (
      data: { producerId: string; paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();
    await toggleCameraHandler(
      { producerId: producer.id, paused: true },
      callback,
    );

    expect(refreshWebcamReceiverCapacityProof).toHaveBeenCalledOnce();
    expect(refreshWebcamReceiverCapacityProof).toHaveBeenCalledWith(
      producer.id,
    );
    expect(callback).toHaveBeenCalledWith({ success: true });
  });
});
