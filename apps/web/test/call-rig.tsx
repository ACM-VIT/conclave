import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import { requestJoinInfo } from "../src/app/lib/join-info-request";

type Listener = (...args: never[]) => unknown;
type Ack = (response: unknown) => void;
type SocketApi = ReturnType<typeof useMeetSocket>;
type Refs = ReturnType<typeof useMeetRefs>;
type Options = Parameters<typeof useMeetSocket>[0];

export const RIG_START = Date.UTC(2030, 0, 1, 12, 0, 0);
export const ROOM = "rig-room";
const TURN_URL = "turn:turn.rig.test:3478?transport=udp";
const STUN = { urls: "stun:stun.rig.test:3478" };

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (...values: unknown[]) => unknown)(...args);
    }
  }
  count(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const fakeTrack = (kind: string) => ({
  id: `track-${kind}-${Math.random().toString(36).slice(2)}`,
  kind,
  readyState: "live",
  enabled: true,
  muted: false,
  onmute: null,
  onunmute: null,
  onended: null,
  stop() {},
  getSettings: () => ({}),
  addEventListener() {},
  removeEventListener() {},
});

export type Generation = {
  username: string;
  sentAt: number;
  expiresAt: number;
};

export class FakeTransport extends Emitter {
  readonly createdAt: number;
  closed = false;
  connectionState: RTCPeerConnectionState = "new";
  readonly observer = new Emitter();
  private connectStarted = false;
  carriedBytes = 0;
  accruedAt: number | null = null;
  connectedAt: number | null = null;
  allocatedGeneration: Generation | null = null;
  reportAt: number | null = null;
  restartIceCalls = 0;

  constructor(
    private readonly rig: CallRig,
    readonly id: string,
    readonly direction: "send" | "recv",
    readonly options: { iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy },
  ) {
    super();
    this.createdAt = Date.now();
  }

  get policy(): RTCIceTransportPolicy {
    return this.options.iceTransportPolicy ?? "all";
  }

  get turnUsernames(): string[] {
    return (this.options.iceServers ?? [])
      .filter((server) => [server.urls].flat().some((url) => String(url).startsWith("turn")))
      .map((server) => String(server.username));
  }

  get offeredGenerations(): Generation[] {
    return this.turnUsernames
      .map((username) => this.rig.generations.find((generation) => generation.username === username))
      .filter((generation): generation is Generation => Boolean(generation));
  }

  setState(state: RTCPeerConnectionState) {
    if (this.closed || this.connectionState === state) return;
    this.connectionState = state;
    if (state === "connected" && this.connectedAt === null) this.connectedAt = Date.now();
    this.emit("connectionstatechange", state);
  }

  get usableGeneration(): Generation | null {
    return (
      this.offeredGenerations
        .filter((generation) => generation.expiresAt > Date.now())
        .sort((a, b) => b.sentAt - a.sentAt)[0] ?? null
    );
  }

  private async startConnecting() {
    if (this.connectStarted) return;
    this.connectStarted = true;
    await new Promise<void>((resolve, reject) => {
      this.emit("connect", { dtlsParameters: {} }, resolve, reject);
    });
    this.setState("connecting");
    this.rig.scheduleConnect(this);
  }

  hasConsumers = false;

  async consume(params: { id: string; producerId: string; kind: "audio" | "video"; rtpParameters: unknown }) {
    await this.startConnecting();
    this.hasConsumers = true;
    const consumer = {
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
      track: fakeTrack(params.kind),
      paused: false,
      closed: false,
      appData: {},
      observer: new Emitter(),
      on() {},
      off() {},
      close() {
        consumer.closed = true;
      },
      pause() {
        consumer.paused = true;
      },
      resume() {
        consumer.paused = false;
      },
      getStats: async () => new Map(),
    };
    return consumer;
  }

  async produce() {
    await this.startConnecting();
    throw new Error("the rig does not publish");
  }

  async restartIce() {
    this.restartIceCalls += 1;
    this.rig.onIceRestart(this);
  }

  async getStats() {
    this.rig.accrue(this);
    const relay = this.rig.carriesOverRelay(this);
    const entries: Array<[string, Record<string, unknown>]> = [
      ["T1", { type: "transport", id: "T1", selectedCandidatePairId: "CP1" }],
      [
        "CP1",
        {
          type: "candidate-pair",
          id: "CP1",
          localCandidateId: "L1",
          state: "succeeded",
          nominated: true,
          bytesReceived: this.direction === "recv" ? this.carriedBytes : 0,
          bytesSent: this.direction === "send" ? this.carriedBytes : 0,
        },
      ],
      [
        "L1",
        relay
          ? { type: "local-candidate", id: "L1", candidateType: "relay", url: TURN_URL }
          : { type: "local-candidate", id: "L1", candidateType: "host" },
      ],
    ];
    if (this.direction === "recv") {
      entries.push(["IN1", { type: "inbound-rtp", id: "IN1", kind: "audio", bytesReceived: this.carriedBytes }]);
    } else {
      entries.push(["OUT1", { type: "outbound-rtp", id: "OUT1", kind: "audio", bytesSent: this.carriedBytes }]);
      if (this.reportAt !== null) {
        entries.push(["RI1", { type: "remote-inbound-rtp", id: "RI1", kind: "audio", timestamp: this.reportAt }]);
      }
    }
    return new Map(entries);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
  }
}

type FakeSocket = {
  id: string;
  connected: boolean;
  on: (event: string, listener: Listener) => FakeSocket;
  off: (event: string, listener: Listener) => FakeSocket;
  emit: (event: string, ...args: unknown[]) => FakeSocket;
  disconnect: () => FakeSocket;
  timeout: (ms: number) => { emit: (event: string, ...args: unknown[]) => FakeSocket };
  dispatch: (event: string, ...args: unknown[]) => void;
  io: { on: () => void; off: () => void };
};

export type RigOptions = {
  directWorks?: boolean;
  ttlSeconds?: number;
  relayConnectMs?: number;
  remoteProducers?: number;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

export class CallRig {
  api!: SocketApi;
  refs!: Refs;
  root: Root | null = null;
  directWorks: boolean;
  relayWorks = true;
  provider: "up" | "down" = "up";
  route: "up" | "down" | "hold" = "up";
  ttlSeconds: number;
  relayConnectMs: number;
  refuseIceRestart = false;
  relayFailsOnExpiry = false;
  answerDelayMs = 300;
  routePlan: Array<"answer" | "hold" | "fail"> = [];
  holdProducersMs = 0;
  mediaFlows = true;
  consumerIds = new Map<string, string>();
  moves: Array<{ at: number; closing: FakeTransport | undefined; bytes: number }> = [];
  transports: FakeTransport[] = [];
  sockets: FakeSocket[] = [];
  generations: Generation[] = [];
  joinRequests: Array<{ at: number; outcome: string }> = [];
  heldRoutes: Pending[] = [];
  log: string[] = [];
  private nextId = 1;
  private remoteProducers: Array<{ producerId: string; producerUserId: string; kind: "audio"; type: "webcam"; paused: boolean }>;

  constructor(options: RigOptions = {}) {
    this.directWorks = options.directWorks ?? true;
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.relayConnectMs = options.relayConnectMs ?? 200;
    this.remoteProducers = Array.from({ length: options.remoteProducers ?? 1 }, (_, index) => ({
      producerId: `remote-mic-${index}`,
      producerUserId: `remote-${index}#s`,
      kind: "audio" as const,
      type: "webcam" as const,
      paused: false,
    }));
  }

  get recv(): FakeTransport | undefined {
    return this.transports.filter((transport) => transport.direction === "recv").at(-1);
  }

  get recvTransports(): FakeTransport[] {
    return this.transports.filter((transport) => transport.direction === "recv");
  }

  get socket(): FakeSocket | undefined {
    return this.sockets.at(-1);
  }

  relayUsableNow(generation: Generation | undefined) {
    return Boolean(generation && generation.expiresAt - Date.now() > 0);
  }

  direct(transport: FakeTransport): boolean {
    return transport.policy === "all" && this.directWorks;
  }

  canConnect(transport: FakeTransport): boolean {
    if (transport.closed) return false;
    if (this.direct(transport)) return true;
    return this.relayWorks && transport.usableGeneration !== null;
  }

  pathWorks(transport: FakeTransport): boolean {
    if (transport.closed || transport.connectionState !== "connected") return false;
    if (this.direct(transport)) return true;
    const allocation = transport.allocatedGeneration;
    if (!allocation || !this.relayWorks) return false;
    return !this.relayFailsOnExpiry || allocation.expiresAt > Date.now();
  }

  carriesOverRelay(transport: FakeTransport): boolean {
    return !this.direct(transport) && transport.allocatedGeneration !== null;
  }

  scheduleConnect(transport: FakeTransport) {
    const delay = this.direct(transport) ? 100 : this.relayConnectMs;
    window.setTimeout(() => {
      if (transport.closed) return;
      if (this.canConnect(transport)) {
        if (!this.direct(transport)) transport.allocatedGeneration = transport.usableGeneration;
        transport.setState("connected");
      } else {
        window.setTimeout(() => transport.setState("failed"), 5_000);
      }
    }, delay);
  }

  onIceRestart(transport: FakeTransport) {
    window.setTimeout(() => {
      if (transport.closed) return;
      if (this.canConnect(transport)) {
        if (!this.direct(transport)) transport.allocatedGeneration = transport.usableGeneration;
        transport.setState("connected");
      } else {
        transport.setState("failed");
      }
    }, 300);
  }

  accrue(transport: FakeTransport) {
    const now = Date.now();
    const since = transport.accruedAt ?? now;
    transport.accruedAt = now;
    if (!this.pathWorks(transport) || !transport.hasConsumers) return;
    if (this.mediaFlows && this.remoteProducers.some((producer) => !producer.paused)) {
      transport.carriedBytes += Math.round((now - since) * 1.6);
      transport.reportAt = now;
    }
  }

  failRelayPaths() {
    for (const transport of this.transports) {
      if (
        !transport.closed &&
        transport.connectionState === "connected" &&
        !this.direct(transport) &&
        !this.pathWorks(transport)
      ) {
        transport.setState("failed");
      }
    }
  }

  newGeneration(): Generation {
    const sentAt = Date.now();
    const generation = {
      username: `gen-${this.generations.length + 1}`,
      sentAt,
      expiresAt: sentAt + this.ttlSeconds * 1000,
    };
    this.generations.push(generation);
    return generation;
  }

  private token() {
    const claims = btoa(JSON.stringify({ exp: Math.floor((RIG_START + 24 * 3600_000) / 1000) }));
    return `header.${claims}.signature`;
  }

  private answer() {
    if (this.provider === "down") {
      return { token: this.token(), sfuUrl: "http://sfu.rig.test", iceServers: [STUN] };
    }
    const generation = this.newGeneration();
    return {
      token: this.token(),
      sfuUrl: "http://sfu.rig.test",
      iceServers: [STUN, { urls: TURN_URL, username: generation.username, credential: "secret" }],
      iceServersTtlSeconds: this.ttlSeconds,
    };
  }

  fetch = (_url: string, init?: RequestInit): Promise<unknown> => {
    const signal = init?.signal ?? null;
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      const reply = () => {
        if (signal?.aborted) return;
        const body = this.answer();
        this.joinRequests.push({ at: Date.now(), outcome: body.iceServers.length > 1 ? "relay" : "stun-only" });
        this.log.push(`${((Date.now() - RIG_START) / 1000).toFixed(1)}s route answered ${body.iceServers.length > 1 ? this.generations.at(-1)?.username : "stun-only"}`);
        resolve({ ok: true, status: 200, json: async () => body });
      };
      const plan = this.routePlan.shift() ?? (this.route === "up" ? "answer" : this.route === "down" ? "fail" : "hold");
      if (plan === "fail") {
        this.joinRequests.push({ at: Date.now(), outcome: "unreachable" });
        window.setTimeout(() => reject(new TypeError("Failed to fetch")), this.answerDelayMs);
      } else if (plan === "hold") {
        this.heldRoutes.push({
          resolve: () => reply(),
          reject: (error) => {
            this.joinRequests.push({ at: Date.now(), outcome: "unreachable" });
            reject(error);
          },
        });
      } else {
        window.setTimeout(reply, this.answerDelayMs);
      }
    });
  };

  releaseHeldRoutes(outcome: "answer" | "fail") {
    const held = this.heldRoutes.splice(0);
    this.log.push(`${((Date.now() - RIG_START) / 1000).toFixed(1)}s route released ${held.length} held as ${outcome}`);
    for (const pending of held) {
      if (outcome === "answer") pending.resolve(undefined);
      else pending.reject(new TypeError("Failed to fetch"));
    }
  }

  private ack(ack: Ack | null, response: unknown, delayMs = 0) {
    if (!ack) return;
    if (delayMs > 0) window.setTimeout(() => ack(response), delayMs);
    else queueMicrotask(() => ack(response));
  }

  private handle(_socket: FakeSocket, event: string, payload: Record<string, unknown> | undefined, ack: Ack | null) {
    switch (event) {
      case "joinRoom":
        return this.ack(ack, {
          status: "joined",
          roomId: ROOM,
          existingProducers: this.remoteProducers,
          rtpCapabilities: { codecs: [], headerExtensions: [] },
          hostUserId: "remote-0#s",
        });
      case "updateMediaCapabilities":
        return this.ack(ack, { error: "not in the rig" });
      case "createConsumerTransport":
      case "createProducerTransport":
        return this.ack(ack, {
          id: `server-transport-${this.nextId++}`,
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {},
        });
      case "getProducers": {
        const hold = this.holdProducersMs;
        this.holdProducersMs = 0;
        return this.ack(ack, { producers: this.remoteProducers }, hold);
      }
      case "consume": {
        const producer = this.remoteProducers.find((entry) => entry.producerId === payload?.producerId);
        const consumerId = `consumer-${this.nextId++}`;
        this.consumerIds.set(String(payload?.producerId), consumerId);
        return this.ack(ack, {
          id: consumerId,
          producerId: payload?.producerId,
          kind: producer?.kind ?? "audio",
          rtpParameters: { codecs: [], encodings: [], headerExtensions: [], rtcp: {} },
          producerPaused: producer?.paused ?? false,
        });
      }
      case "restartIce":
        return this.ack(
          ack,
          this.refuseIceRestart ? { error: "Transport not available for restart" } : { iceParameters: {} },
        );
      default:
        return this.ack(ack, { success: true });
    }
  }

  io = () => {
    const listeners = new Emitter();
    const socket: FakeSocket = {
      id: `socket-${this.sockets.length + 1}`,
      connected: false,
      on: (event, listener) => {
        listeners.on(event, listener);
        return socket;
      },
      off: (event, listener) => {
        listeners.off(event, listener);
        return socket;
      },
      emit: (event, ...args) => {
        const ack = typeof args.at(-1) === "function" ? (args.pop() as Ack) : null;
        this.handle(socket, event, args[0] as Record<string, unknown> | undefined, ack);
        return socket;
      },
      disconnect: () => {
        if (socket.connected) {
          socket.connected = false;
          listeners.emit("disconnect", "io client disconnect");
        }
        return socket;
      },
      timeout: (ms) => ({
        emit: (event, ...args) => {
          const ack = args.pop() as (error: Error | null, ...responses: unknown[]) => void;
          let settled = false;
          const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            ack(new Error("operation has timed out"));
          }, ms);
          return socket.emit(event, ...args, (response: unknown) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            ack(null, response);
          });
        },
      }),
      dispatch: (event, ...args) => listeners.emit(event, ...args),
      io: { on() {}, off() {} },
    };
    this.sockets.push(socket);
    window.setTimeout(() => {
      socket.connected = true;
      listeners.emit("connect");
    }, 10);
    return socket;
  };

  deviceClass() {
    const rig = this;
    return class FakeDevice {
      handlerName = "Chrome111";
      loaded = false;
      rtpCapabilities = { codecs: [], headerExtensions: [] };
      recvRtpCapabilities = { codecs: [], headerExtensions: [] };
      sctpCapabilities = {};
      async load() {
        this.loaded = true;
      }
      canProduce() {
        return true;
      }
      createSendTransport(options: FakeTransport["options"] & { id: string }) {
        return rig.addTransport("send", options);
      }
      createRecvTransport(options: FakeTransport["options"] & { id: string }) {
        return rig.addTransport("recv", options);
      }
    };
  }

  addTransport(direction: "send" | "recv", options: FakeTransport["options"] & { id: string }) {
    const transport = new FakeTransport(this, options.id, direction, options);
    this.transports.push(transport);
    this.log.push(`${((Date.now() - RIG_START) / 1000).toFixed(1)}s ${direction} transport ${transport.policy} [${transport.turnUsernames.join(",")}]`);
    return transport;
  }

  pauseRemoteProducers(paused: boolean) {
    for (const producer of this.remoteProducers) {
      producer.paused = paused;
      this.socket?.dispatch("consumerTelemetry", {
        roomId: ROOM,
        userId: "viewer#session",
        consumerId: this.consumerIds.get(producer.producerId),
        producerId: producer.producerId,
        kind: producer.kind,
        score: { score: 10, producerScore: paused ? 0 : 10, producerScores: [paused ? 0 : 10] },
        paused: false,
        producerPaused: paused,
        priority: 255,
        event: paused ? "producerpause" : "producerresume",
        timestamp: Date.now(),
      });
    }
  }

  announceProducer() {
    const producer = {
      producerId: `remote-mic-${this.remoteProducers.length}`,
      producerUserId: `remote-${this.remoteProducers.length}#s`,
      kind: "audio" as const,
      type: "webcam" as const,
      paused: false,
    };
    this.remoteProducers.push(producer);
    this.socket?.dispatch("newProducer", { ...producer, roomId: ROOM });
  }

  get lastRelayAnswerAt(): number | null {
    return this.joinRequests.filter((request) => request.outcome === "relay").at(-1)?.at ?? null;
  }

  watchWarnings() {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      this.log.push(`${((Date.now() - RIG_START) / 1000).toFixed(1)}s ERROR ${args.map(String).join(" ").slice(0, 140)}`);
    });
    const warn = console.warn.bind(console);
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ");
      this.log.push(`${((Date.now() - RIG_START) / 1000).toFixed(1)}s ${text.slice(0, 140)}`);
      if (text.includes("moving the")) {
        const closing = this.recv;
        this.moves.push({ at: Date.now(), closing, bytes: closing?.carriedBytes ?? 0 });
      }
      void warn;
    });
  }

  async mount() {
    const noop = () => {};
    const rig = this;
    const supplied: Record<string, unknown> = {
      roomId: ROOM,
      userId: "viewer#session",
      isAdmin: false,
      displayNameInput: "Viewer",
      localStream: null,
      isMuted: true,
      isCameraOff: true,
      isTtsDisabled: false,
      getJoinInfo: (roomId: string, sessionId: string, options?: { signal?: AbortSignal }) =>
        requestJoinInfo(
          "/api/sfu/join",
          { method: "POST", body: JSON.stringify({ roomId, sessionId }) },
          { signal: options?.signal },
        ),
      prewarm: { io: this.io, Device: this.deviceClass(), isReady: true },
      videoQualityRef: { current: "standard" },
      mediaQualitySettingsRef: { current: {} },
      updateVideoQualityRef: { current: async () => {} },
      requestMediaPermissions: async () => null,
      chat: {
        setChatMessages: noop,
        setChatOverlayMessages: noop,
        setUnreadCount: noop,
        isChatOpenRef: { current: false },
      },
    };
    const options = new Proxy(supplied, {
      get: (target, key) =>
        key in target
          ? Reflect.get(target, key)
          : typeof key === "string" && /^(set|request|handle|on|play|prime|add|clear|stop|dispatch|prepare)[A-Z]?/.test(key)
            ? noop
            : undefined,
      has: (target, key) => key in target,
    }) as unknown as Options;
    function Rig() {
      const refs = useMeetRefs();
      supplied.refs = refs;
      rig.refs = refs;
      rig.api = useMeetSocket(options);
      return null;
    }
    const container = document.createElement("div");
    this.root = createRoot(container);
    await act(async () => {
      this.root?.render(createElement(Rig));
    });
  }

  async join() {
    let joined = false;
    await act(async () => {
      void this.api.joinRoomById(ROOM).then(() => {
        joined = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    if (!joined) throw new Error(`join did not finish: ${this.log.join(" | ")}`);
    await this.advance(3_000);
  }

  async advance(ms: number) {
    await act(async () => {
      let left = ms;
      while (left > 0) {
        const step = Math.min(250, left);
        await vi.advanceTimersByTimeAsync(step);
        for (const transport of this.transports) this.accrue(transport);
        this.failRelayPaths();
        left -= step;
      }
    });
  }

  async flush() {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }

  async dropSocket() {
    const socket = this.socket;
    if (!socket) throw new Error("no socket");
    await act(async () => {
      socket.connected = false;
      socket.dispatch("disconnect", "transport close");
    });
  }

  failRecv() {
    const transport = this.recv;
    if (!transport) throw new Error("no receive transport");
    transport.setState("failed");
  }

  get health() {
    return this.api.mediaPathHealth;
  }

  async unmount() {
    await act(async () => {
      this.api.cleanup();
      this.root?.unmount();
    });
  }
}

export const startRig = async (options: RigOptions = {}) => {
  vi.useFakeTimers({ now: RIG_START });
  const rig = new CallRig(options);
  vi.stubGlobal("fetch", rig.fetch);
  rig.watchWarnings();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await rig.mount();
  return rig;
};

export const stopRig = async (rig: CallRig | null) => {
  if (rig) await rig.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
};
