/* eslint-disable @typescript-eslint/unbound-method -- mediasoup methods are Vitest mocks in this race harness. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Consumer, WebRtcTransport } from "mediasoup/types";
import type { Socket } from "socket.io";
import { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import {
  DISPLACED_CONSUMER_CLOSE_DELAY_MS,
  registerMediaHandlers,
} from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const createValueDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const makeConsumer = (
  id: string,
  options: {
    producerId?: string;
    paused?: boolean;
    setPreferredLayersImplementation?: () => Promise<void>;
    resumeImplementation?: () => Promise<void>;
  } = {},
) => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const consumer = {
    id,
    producerId: options.producerId ?? "producer",
    kind: "video",
    type: "simulcast",
    closed: false,
    paused: options.paused ?? true,
    producerPaused: false,
    priority: 100,
    score: { score: 10, producerScore: 10, producerScores: [10, 10, 10] },
    preferredLayers: undefined,
    currentLayers: { spatialLayer: 2, temporalLayer: 0 },
    rtpParameters: { codecs: [], encodings: [] },
    appData: {},
    on: events.on.bind(events),
    observer,
    close: vi.fn(),
    setPreferredLayers: vi.fn(
      options.setPreferredLayersImplementation ?? (async () => undefined),
    ),
    setPriority: vi.fn().mockResolvedValue(undefined),
    unsetPriority: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(async () => {
      Object.assign(consumer, { paused: true });
    }),
    resume: vi.fn(async () => {
      await (options.resumeImplementation?.() ?? Promise.resolve());
      Object.assign(consumer, { paused: false });
    }),
    requestKeyFrame: vi.fn().mockResolvedValue(undefined),
  } as unknown as Consumer;
  vi.mocked(consumer.close).mockImplementation(() => {
    Object.assign(consumer, { closed: true });
    observer.emit("close");
  });
  return consumer;
};

const makeHarness = (
  options: {
    clientMode?: "participant" | "webinar_attendee";
    roomQuality?: "low" | "standard" | "high";
    producerType?: "webcam" | "screen";
  } = {},
) => {
  const handlers = new Map<string, SocketHandler>();
  const roomBroadcast = { emit: vi.fn() };
  const socket = {
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    to: vi.fn().mockReturnValue(roomBroadcast),
    connected: true,
  } as unknown as Socket;
  const client = new Client({
    id: "receiver",
    socket,
    ...(options.clientMode ? { mode: options.clientMode } : {}),
  });
  const room = {
    id: "room",
    channelId: "instance:room",
    currentQuality: options.roomQuality ?? "standard",
    refreshWebcamReceiverCapacityProof: vi.fn(),
    getProducerInfoById: vi.fn().mockReturnValue({
      producerId: "producer",
      producerUserId: "owner",
      kind: "video",
      type: options.producerType ?? "webcam",
      paused: false,
    }),
    producerIdMatchesCurrentWebcamCodecPolicy: vi.fn().mockReturnValue(true),
    canConsume: vi.fn().mockReturnValue(true),
  } as unknown as Room;
  const context = {
    socket,
    io: {} as ConnectionContext["io"],
    state: { rooms: new Map() } as unknown as SfuState,
    currentRoom: room,
    currentClient: client,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  } satisfies ConnectionContext;
  registerMediaHandlers(context);
  return { client, handlers, room, socket };
};

describe("current consumer generation controls", () => {
  it.each([
    {
      name: "a low-quality room",
      harness: { roomQuality: "low" as const },
    },
    {
      name: "a webinar attendee",
      harness: { clientMode: "webinar_attendee" as const },
    },
  ])("defaults T1 webcam consumers to temporal layer zero for $name", async ({ harness }) => {
    const { client, handlers } = makeHarness(harness);
    const consumer = makeConsumer("consumer-webcam");
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(consumer),
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as ConsumeHandler;

    await handler(
      {
        transportId: "recv-transport",
        producerId: "producer",
        rtpCapabilities: {},
      },
      vi.fn(),
    );

    expect(consumer.setPreferredLayers).toHaveBeenCalledWith({
      spatialLayer: 0,
      temporalLayer: 0,
    });
  });

  it("keeps the screen-share temporal default unchanged", async () => {
    const { client, handlers } = makeHarness({ producerType: "screen" });
    const consumer = makeConsumer("consumer-screen");
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(consumer),
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as ConsumeHandler;

    await handler(
      {
        transportId: "recv-transport",
        producerId: "producer",
        rtpCapabilities: {},
      },
      vi.fn(),
    );

    expect(consumer.setPreferredLayers).toHaveBeenCalledWith({
      spatialLayer: 0,
      temporalLayer: 2,
    });
  });

  it("rejects a displaced resume without resuming, requesting a keyframe, or succeeding", async () => {
    const { client, handlers, socket } = makeHarness();
    const predecessor = makeConsumer("consumer-1");
    const successor = makeConsumer("consumer-2");
    client.addConsumer(predecessor);
    client.addConsumer(successor);
    const handler = handlers.get("resumeConsumer") as unknown as (
      data: { consumerId: string; requestKeyFrame: boolean },
      callback: (response: unknown) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    await handler(
      { consumerId: predecessor.id, requestKeyFrame: true },
      callback,
    );

    expect(predecessor.resume).not.toHaveBeenCalled();
    expect(predecessor.requestKeyFrame).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith(
      "consumerTelemetry",
      expect.anything(),
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      error: "Consumer generation displaced",
      code: "displaced",
    });
  });

  it("stops a resume race before PLI, telemetry, or success", async () => {
    const resume = createDeferred();
    const { client, handlers, socket } = makeHarness();
    const current = makeConsumer("consumer-1", {
      resumeImplementation: () => resume.promise,
    });
    const successor = makeConsumer("consumer-2");
    client.addConsumer(current);
    const handler = handlers.get("resumeConsumer") as unknown as (
      data: { consumerId: string; requestKeyFrame: boolean },
      callback: (response: unknown) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    const request = handler(
      { consumerId: current.id, requestKeyFrame: true },
      callback,
    );
    await vi.waitFor(() => expect(current.resume).toHaveBeenCalledOnce());
    client.addConsumer(successor);
    resume.resolve();
    await request;

    expect(current.requestKeyFrame).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith(
      "consumerTelemetry",
      expect.anything(),
    );
    expect(callback).toHaveBeenCalledWith({
      error: "Consumer generation displaced",
      code: "displaced",
    });
  });

  it("stops preference work when its generation is displaced mid-await", async () => {
    const preferredLayers = createDeferred();
    const { client, handlers, socket } = makeHarness();
    const current = makeConsumer("consumer-1", {
      setPreferredLayersImplementation: () => preferredLayers.promise,
    });
    const successor = makeConsumer("consumer-2");
    client.addConsumer(current);
    const handler = handlers.get("setConsumerPreferences") as unknown as (
      data: {
        consumerId: string;
        preferredLayers: { spatialLayer: number; temporalLayer: number };
        priority: number;
        paused: boolean;
        requestKeyFrame: boolean;
      },
      callback: (response: unknown) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    const request = handler(
      {
        consumerId: current.id,
        preferredLayers: { spatialLayer: 1, temporalLayer: 0 },
        priority: 200,
        paused: false,
        requestKeyFrame: true,
      },
      callback,
    );
    await vi.waitFor(() =>
      expect(current.setPreferredLayers).toHaveBeenCalledOnce(),
    );
    client.addConsumer(successor);
    preferredLayers.resolve();
    await request;

    expect(current.setPriority).not.toHaveBeenCalled();
    expect(current.resume).not.toHaveBeenCalled();
    expect(current.requestKeyFrame).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith(
      "consumerTelemetry",
      expect.anything(),
    );
    expect(callback).toHaveBeenCalledWith({
      error: "Consumer generation displaced",
      consumerId: current.id,
    });
  });

  it("keeps targeted close available for a displaced predecessor", () => {
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-1");
    const successor = makeConsumer("consumer-2");
    client.addConsumer(predecessor);
    client.addConsumer(successor);
    const handler = handlers.get("closeConsumer") as unknown as (
      data: { consumerId: string },
      callback: (response: unknown) => void,
    ) => void;
    const callback = vi.fn();

    handler({ consumerId: predecessor.id }, callback);

    expect(predecessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBe(successor);
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it("accepts controls again after a failed successor restores its predecessor", async () => {
    const { client, handlers, socket } = makeHarness();
    const predecessor = makeConsumer("consumer-1", { paused: false });
    const failedSuccessor = makeConsumer("consumer-2");
    client.addConsumer(predecessor, {
      producerUserId: "owner",
      type: "webcam",
    });
    client.addConsumer(failedSuccessor, {
      producerUserId: "owner",
      type: "webcam",
    });
    failedSuccessor.close();
    const handler = handlers.get("setConsumerPreferences") as unknown as (
      data: { consumerId: string; priority: number },
      callback: (response: unknown) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    await handler({ consumerId: predecessor.id, priority: 180 }, callback);

    expect(predecessor.setPriority).toHaveBeenCalledWith(180);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        consumerId: predecessor.id,
        producerId: predecessor.producerId,
      }),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      "consumerTelemetry",
      expect.objectContaining({
        consumerId: predecessor.id,
        producerId: predecessor.producerId,
      }),
    );
  });

  it("uses a retirement grace beyond delayed ACK and handoff windows", () => {
    expect(DISPLACED_CONSUMER_CLOSE_DELAY_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps a predecessor flowing for the full retirement grace", async () => {
    vi.useFakeTimers();
    try {
      const { client, handlers } = makeHarness();
      const predecessor = makeConsumer("consumer-1", { paused: false });
      const successor = makeConsumer("consumer-2");
      client.addConsumer(predecessor);
      client.consumerTransport = {
        id: "recv-transport",
        consume: vi.fn().mockResolvedValue(successor),
      } as unknown as WebRtcTransport;
      const handler = handlers.get("consume") as unknown as (
        data: {
          transportId: string;
          producerId: string;
          rtpCapabilities: Record<string, unknown>;
        },
        callback: (response: unknown) => void,
      ) => Promise<void>;
      const callback = vi.fn();

      await handler(
        {
          transportId: "recv-transport",
          producerId: "producer",
          rtpCapabilities: {},
        },
        callback,
      );
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ id: successor.id }),
      );

      await vi.advanceTimersByTimeAsync(
        DISPLACED_CONSUMER_CLOSE_DELAY_MS - 1,
      );
      expect(predecessor.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(predecessor.close).toHaveBeenCalledOnce();
      expect(client.getConsumer("producer")).toBe(successor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects consume setup when an overlapping consume becomes current", async () => {
    const priority = createDeferred();
    const { client, handlers } = makeHarness();
    const candidate = makeConsumer("consumer-1");
    vi.mocked(candidate.setPriority).mockImplementation(() => priority.promise);
    const successor = makeConsumer("consumer-2");
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(candidate),
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as (
      data: {
        transportId: string;
        producerId: string;
        rtpCapabilities: Record<string, unknown>;
      },
      callback: (response: unknown) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    const request = handler(
      {
        transportId: "recv-transport",
        producerId: "producer",
        rtpCapabilities: {},
      },
      callback,
    );
    await vi.waitFor(() => expect(candidate.setPriority).toHaveBeenCalledOnce());
    client.addConsumer(successor);
    expect(client.getConsumerById(candidate.id)).toBe(candidate);
    expect(client.getConsumer("producer")).toBe(successor);
    priority.resolve();
    await request;

    expect(candidate.close).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      error: "Consumer displaced during setup",
      code: "displaced",
    });
    expect(callback).toHaveBeenCalledOnce();
  });
});

const HANDOFF_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_HANDOFF_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

type ConsumeHandler = (
  data: {
    transportId: string;
    producerId: string;
    rtpCapabilities: Record<string, unknown>;
    plannedConsumerHandoff?: {
      requestId: string;
      predecessorConsumerId: string;
    };
  },
  callback: (response: unknown) => void,
) => Promise<void>;

type AbortHandoffHandler = (
  data: {
    requestId: string;
    producerId: string;
    predecessorConsumerId: string;
  },
  callback: (response: unknown) => void,
) => void;

const plannedConsumeData = (
  requestId = HANDOFF_REQUEST_ID,
  predecessorConsumerId = "consumer-predecessor",
) => ({
  transportId: "recv-transport",
  producerId: "producer",
  rtpCapabilities: {},
  plannedConsumerHandoff: { requestId, predecessorConsumerId },
});

const abortHandoffData = (
  requestId = HANDOFF_REQUEST_ID,
  predecessorConsumerId = "consumer-predecessor",
) => ({
  requestId,
  producerId: "producer",
  predecessorConsumerId,
});

describe("planned consumer handoff acknowledgements", () => {
  it("reserves before async creation and fences a late completion after abort", async () => {
    const creation = createValueDeferred<Consumer>();
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const lateSuccessor = makeConsumer("consumer-late");
    client.addConsumer(predecessor);
    const consume = vi.fn().mockReturnValue(creation.promise);
    client.consumerTransport = {
      id: "recv-transport",
      consume,
    } as unknown as WebRtcTransport;
    const consumeHandler = handlers.get("consume") as unknown as ConsumeHandler;
    const abortHandler = handlers.get(
      "abortConsumerHandoff",
    ) as unknown as AbortHandoffHandler;
    const consumeCallback = vi.fn();
    const abortCallback = vi.fn();

    const request = consumeHandler(plannedConsumeData(), consumeCallback);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    abortHandler(abortHandoffData(), abortCallback);

    expect(abortCallback).toHaveBeenCalledWith({
      success: true,
      requestId: HANDOFF_REQUEST_ID,
      status: "aborted",
      predecessorRestored: true,
    });
    creation.resolve(lateSuccessor);
    await request;

    expect(lateSuccessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBe(predecessor);
    expect(consumeCallback).toHaveBeenCalledWith({
      error: "Planned consumer handoff was aborted during setup",
      code: "aborted",
    });

    const replayCallback = vi.fn();
    await consumeHandler(plannedConsumeData(), replayCallback);
    expect(consume).toHaveBeenCalledOnce();
    expect(replayCallback).toHaveBeenCalledWith({
      error: "Planned consumer handoff aborted",
      code: "aborted",
    });
  });

  it("deduplicates concurrent exact requests onto one server consumer", async () => {
    const priority = createDeferred();
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const successor = makeConsumer("consumer-successor");
    vi.mocked(successor.setPriority).mockImplementation(() => priority.promise);
    client.addConsumer(predecessor);
    const consume = vi.fn().mockResolvedValue(successor);
    client.consumerTransport = {
      id: "recv-transport",
      consume,
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as ConsumeHandler;
    const firstCallback = vi.fn();
    const duplicateCallback = vi.fn();

    const first = handler(plannedConsumeData(), firstCallback);
    await vi.waitFor(() =>
      expect(successor.setPriority).toHaveBeenCalledOnce(),
    );
    const duplicate = handler(plannedConsumeData(), duplicateCallback);
    priority.resolve();
    await Promise.all([first, duplicate]);

    expect(consume).toHaveBeenCalledOnce();
    const expectedResponse: unknown = expect.objectContaining({
      id: successor.id,
      producerId: "producer",
      plannedConsumerHandoffRequestId: HANDOFF_REQUEST_ID,
    });
    expect(firstCallback).toHaveBeenCalledWith(expectedResponse);
    expect(duplicateCallback).toHaveBeenCalledWith(expectedResponse);
  });

  it("aborts an attached successor before its delayed consume ACK", async () => {
    const priority = createDeferred();
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const successor = makeConsumer("consumer-successor");
    vi.mocked(successor.setPriority).mockImplementation(() => priority.promise);
    client.addConsumer(predecessor);
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(successor),
    } as unknown as WebRtcTransport;
    const consumeHandler = handlers.get("consume") as unknown as ConsumeHandler;
    const abortHandler = handlers.get(
      "abortConsumerHandoff",
    ) as unknown as AbortHandoffHandler;
    const consumeCallback = vi.fn();
    const abortCallback = vi.fn();

    const request = consumeHandler(plannedConsumeData(), consumeCallback);
    await vi.waitFor(() =>
      expect(successor.setPriority).toHaveBeenCalledOnce(),
    );
    expect(client.getConsumer("producer")).toBe(successor);

    abortHandler(abortHandoffData(), abortCallback);
    expect(abortCallback).toHaveBeenCalledWith({
      success: true,
      requestId: HANDOFF_REQUEST_ID,
      status: "aborted",
      successorConsumerId: successor.id,
      predecessorRestored: true,
    });
    expect(client.getConsumer("producer")).toBe(predecessor);

    priority.resolve();
    await request;
    expect(consumeCallback).toHaveBeenCalledWith({
      error: "Consumer displaced during setup",
      code: "displaced",
    });
    expect(predecessor.close).not.toHaveBeenCalled();
  });

  it("rolls back a committed successor after a dropped ACK and invalidates its retirement timer", async () => {
    vi.useFakeTimers();
    try {
      const { client, handlers } = makeHarness();
      const predecessor = makeConsumer("consumer-predecessor", {
        paused: false,
      });
      const successor = makeConsumer("consumer-successor");
      client.addConsumer(predecessor);
      client.consumerTransport = {
        id: "recv-transport",
        consume: vi.fn().mockResolvedValue(successor),
      } as unknown as WebRtcTransport;
      const consumeHandler = handlers.get("consume") as unknown as ConsumeHandler;
      const abortHandler = handlers.get(
        "abortConsumerHandoff",
      ) as unknown as AbortHandoffHandler;

      // The server completes and invokes the callback, but the transport/client
      // may lose that ACK. Only the request id remains available to the client.
      const droppedAck = vi.fn();
      await consumeHandler(plannedConsumeData(), droppedAck);
      expect(droppedAck).toHaveBeenCalledWith(
        expect.objectContaining({
          id: successor.id,
          plannedConsumerHandoffRequestId: HANDOFF_REQUEST_ID,
        }),
      );

      const abortCallback = vi.fn();
      abortHandler(abortHandoffData(), abortCallback);
      expect(abortCallback).toHaveBeenCalledWith({
        success: true,
        requestId: HANDOFF_REQUEST_ID,
        status: "aborted",
        successorConsumerId: successor.id,
        predecessorRestored: true,
      });
      expect(successor.close).toHaveBeenCalledOnce();
      expect(client.getConsumer("producer")).toBe(predecessor);

      const duplicateAbortCallback = vi.fn();
      abortHandler(abortHandoffData(), duplicateAbortCallback);
      expect(duplicateAbortCallback).toHaveBeenCalledWith({
        success: true,
        requestId: HANDOFF_REQUEST_ID,
        status: "already_aborted",
        successorConsumerId: successor.id,
        predecessorRestored: true,
      });
      expect(successor.close).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(DISPLACED_CONSUMER_CLOSE_DELAY_MS);
      expect(predecessor.close).not.toHaveBeenCalled();
      expect(client.getConsumer("producer")).toBe(predecessor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects mismatched ownership without creating or closing another generation", async () => {
    const creation = createValueDeferred<Consumer>();
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const lateSuccessor = makeConsumer("consumer-late");
    client.addConsumer(predecessor);
    const consume = vi.fn().mockReturnValue(creation.promise);
    client.consumerTransport = {
      id: "recv-transport",
      consume,
    } as unknown as WebRtcTransport;
    const consumeHandler = handlers.get("consume") as unknown as ConsumeHandler;
    const abortHandler = handlers.get(
      "abortConsumerHandoff",
    ) as unknown as AbortHandoffHandler;
    const firstCallback = vi.fn();

    const first = consumeHandler(plannedConsumeData(), firstCallback);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());

    const mismatchedConsume = vi.fn();
    await consumeHandler(
      plannedConsumeData(HANDOFF_REQUEST_ID, "other-predecessor"),
      mismatchedConsume,
    );
    expect(mismatchedConsume).toHaveBeenCalledWith({
      error: "Planned consumer handoff request ownership mismatch",
    });

    const mismatchedAbort = vi.fn();
    abortHandler(
      {
        ...abortHandoffData(),
        producerId: "other-producer",
      },
      mismatchedAbort,
    );
    expect(mismatchedAbort).toHaveBeenCalledWith({
      error: "Planned consumer handoff request ownership mismatch",
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(predecessor.close).not.toHaveBeenCalled();

    const exactAbort = vi.fn();
    abortHandler(abortHandoffData(), exactAbort);
    creation.resolve(lateSuccessor);
    await first;
    expect(lateSuccessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBe(predecessor);
  });

  it("does not close anything when the recorded successor is no longer current", async () => {
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const recordedSuccessor = makeConsumer("consumer-successor");
    const unrelatedCurrent = makeConsumer("consumer-unrelated");
    client.addConsumer(predecessor);
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(recordedSuccessor),
    } as unknown as WebRtcTransport;
    const consumeHandler = handlers.get("consume") as unknown as ConsumeHandler;
    const abortHandler = handlers.get(
      "abortConsumerHandoff",
    ) as unknown as AbortHandoffHandler;

    await consumeHandler(plannedConsumeData(), vi.fn());
    client.addConsumer(unrelatedCurrent);
    const abortCallback = vi.fn();
    abortHandler(abortHandoffData(), abortCallback);

    expect(abortCallback).toHaveBeenCalledWith({
      error: "Planned consumer handoff predecessor was not safely restored",
    });
    expect(recordedSuccessor.close).not.toHaveBeenCalled();
    expect(unrelatedCurrent.close).not.toHaveBeenCalled();
    expect(predecessor.close).not.toHaveBeenCalled();
    expect(client.getConsumer("producer")).toBe(unrelatedCurrent);
  });

  it("fails closed for an absent id unless the exact predecessor is current", () => {
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const unrelatedSuccessor = makeConsumer("consumer-unrelated");
    client.addConsumer(predecessor);
    const abortHandler = handlers.get(
      "abortConsumerHandoff",
    ) as unknown as AbortHandoffHandler;

    const absentCallback = vi.fn();
    abortHandler(
      abortHandoffData(SECOND_HANDOFF_REQUEST_ID),
      absentCallback,
    );
    expect(absentCallback).toHaveBeenCalledWith({
      success: true,
      requestId: SECOND_HANDOFF_REQUEST_ID,
      status: "absent",
      predecessorRestored: true,
    });

    client.addConsumer(unrelatedSuccessor);
    const unsafeAbsentCallback = vi.fn();
    abortHandler(
      abortHandoffData("33333333-3333-4333-8333-333333333333"),
      unsafeAbsentCallback,
    );
    expect(unsafeAbsentCallback).toHaveBeenCalledWith({
      error: "Planned consumer handoff predecessor was not safely restored",
    });
    expect(unrelatedSuccessor.close).not.toHaveBeenCalled();
    expect(client.getConsumer("producer")).toBe(unrelatedSuccessor);
  });

  it("fences pending creation across client teardown", async () => {
    const creation = createValueDeferred<Consumer>();
    const { client, handlers } = makeHarness();
    const predecessor = makeConsumer("consumer-predecessor", { paused: false });
    const lateSuccessor = makeConsumer("consumer-after-disconnect");
    client.addConsumer(predecessor);
    const consume = vi.fn().mockReturnValue(creation.promise);
    client.consumerTransport = {
      id: "recv-transport",
      consume,
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as ConsumeHandler;
    const callback = vi.fn();

    const request = handler(plannedConsumeData(), callback);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    client.closeConsumers();
    creation.resolve(lateSuccessor);
    await request;

    expect(predecessor.close).toHaveBeenCalledOnce();
    expect(lateSuccessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBeUndefined();
    expect(callback).toHaveBeenCalledWith({
      error: "Planned consumer handoff was aborted during setup",
      code: "aborted",
    });
  });

  it("leaves normal consume responses backward compatible", async () => {
    const { client, handlers } = makeHarness();
    const consumer = makeConsumer("consumer-normal");
    client.consumerTransport = {
      id: "recv-transport",
      consume: vi.fn().mockResolvedValue(consumer),
    } as unknown as WebRtcTransport;
    const handler = handlers.get("consume") as unknown as ConsumeHandler;
    const callback = vi.fn();

    await handler(
      {
        transportId: "recv-transport",
        producerId: "producer",
        rtpCapabilities: {},
      },
      callback,
    );

    const response: unknown = callback.mock.calls[0]?.[0];
    expect(response).toMatchObject({ id: consumer.id, producerId: "producer" });
    expect(response).not.toHaveProperty("plannedConsumerHandoffRequestId");
  });
});
