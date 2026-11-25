import { act, createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { useMeetMedia } from "../src/app/hooks/useMeetMedia";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import { useMeetState } from "../src/app/hooks/useMeetState";
import { captureGeneration, captureHeldCanvas } from "../src/app/lib/media-captures";
import { DEFAULT_MEDIA_QUALITY_SETTINGS } from "../src/app/lib/media-quality-settings";
import { getNoiseCancellationSourceTrack } from "../src/app/lib/noise-cancellation";

type Kind = "audio" | "video";
type Listener = (event: Event) => void;

export type Hold = "capture" | "noiseSetup" | "replaceTrack" | "produce" | "consumerTransport" | "toggleMute" | "resume";

export class World {
  tracks: FakeTrack[] = [];
  contexts: FakeAudioContext[] = [];
  producers: FakeProducer[] = [];
  holds = new Set<Hold>();
  pending: Array<{ hold: Hold; release: () => void }> = [];
  failCaptures: Kind[] = [];
  joinRefusal: string | null = null;
  produceRoundTripMs = Number(process.env.IN_CALL_PRODUCE_RTT_MS ?? 0);
  roundTripsInFlight = 0;
  sent: Array<{ producer: string; source: string | null }> = [];
  refusals = new Map<string, number>();
  cameraRefusesConstraints = false;
  contextsStartSuspended = false;
  deviceListeners = new Set<() => void>();
  socketEvents: Array<{ event: string; payload: unknown }> = [];
  framesSent = new Map<string, number>();
  sfu = new Map<string, { kind: Kind; type: string; paused: boolean; closed: boolean }>();
  private count = 0;

  refuse(name: string) {
    const left = this.refusals.get(name) ?? 0;
    if (left <= 0) return false;
    this.refusals.set(name, left - 1);
    return true;
  }

  nextId(prefix: string) {
    this.count += 1;
    return `${prefix}-${this.count}`;
  }

  track(kind: Kind, source: string, deviceId = "default") {
    const track = new FakeTrack(this, this.nextId(`${source}-${kind}`), kind, source, deviceId);
    this.tracks.push(track);
    return track;
  }

  wait(hold: Hold): Promise<void> {
    if (!this.holds.has(hold)) return Promise.resolve();
    return new Promise((resolve) => this.pending.push({ hold, release: resolve }));
  }

  releaseOne(index: number) {
    const [entry] = this.pending.splice(index, 1);
    entry?.release();
  }

  releaseAll() {
    this.holds.clear();
    this.pending.splice(0).forEach((entry) => entry.release());
  }
}

export class FakeTrack {
  readyState: MediaStreamTrackState = "live";
  enabled = true;
  muted = false;
  contentHint = "";
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly world: World,
    readonly id: string,
    readonly kind: Kind,
    readonly source: string,
    readonly deviceId: string,
  ) {}

  stop() {
    this.readyState = "ended";
  }

  lose() {
    if (this.readyState === "ended") return;
    this.readyState = "ended";
    this.onended?.();
    this.listeners.get("ended")?.forEach((listener) => listener(new Event("ended")));
  }

  clone() {
    return this.world.track(this.kind, "clone", this.deviceId);
  }

  getSettings() {
    if (this.kind === "audio") return { deviceId: this.deviceId, sampleRate: 48000, channelCount: 1 };
    return this.world.cameraRefusesConstraints
      ? { deviceId: this.deviceId, width: 160, height: 90, frameRate: 10 }
      : { deviceId: this.deviceId, width: 1280, height: 720, frameRate: 30 };
  }

  getConstraints() {
    return {};
  }

  getCapabilities() {
    return {};
  }

  async applyConstraints() {
    if (this.kind === "video" && (this.world.cameraRefusesConstraints || this.world.refuse("applyConstraints"))) {
      const error = new Error("the rig camera refuses new constraints");
      error.name = "OverconstrainedError";
      throw error;
    }
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
}

export class FakeStream {
  readonly id: string;
  private readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
    this.id = `stream-${this.tracks.map((track) => track.id).join("+")}`;
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  addTrack(track: FakeTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track: FakeTrack) {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }

  addEventListener() {}
  removeEventListener() {}
}

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}

class FakeAudioNode {
  readonly outputs = new Set<FakeAudioNode>();
  type = "";
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  fftSize = 0;
  frequencyBinCount = 0;
  smoothingTimeConstant = 0;
  stream = new FakeStream();

  constructor(readonly context: FakeAudioContext) {}

  connect(node: FakeAudioNode) {
    this.outputs.add(node);
    return node;
  }

  disconnect() {
    this.outputs.clear();
  }

  start() {}
  stop() {}
  getFloatTimeDomainData() {}
  getByteFrequencyData() {}
  getByteTimeDomainData() {}
}

export class FakeAudioContext {
  state: AudioContextState;
  sampleRate = 48000;
  currentTime = 0;
  readonly destination: FakeAudioNode;
  readonly outputs: FakeTrack[] = [];

  private readonly world: World;

  constructor() {
    this.world = activeWorld();
    this.state = this.world.contextsStartSuspended ? "suspended" : "running";
    this.destination = new FakeAudioNode(this);
    this.world.contexts.push(this);
  }

  readonly audioWorklet = {
    addModule: async () => {
      await this.world.wait("noiseSetup");
      throw new Error("no worklets in this rig");
    },
  };

  async resume() {
    await this.world.wait("resume");
    if (this.state !== "closed") this.state = "running";
  }

  async close() {
    this.state = "closed";
  }

  async setSinkId() {
    await this.world.wait("noiseSetup");
  }

  createMediaStreamSource() {
    return new FakeAudioNode(this);
  }

  createBiquadFilter() {
    return new FakeAudioNode(this);
  }

  createDynamicsCompressor() {
    return new FakeAudioNode(this);
  }

  createGain() {
    return new FakeAudioNode(this);
  }

  createAnalyser() {
    return new FakeAudioNode(this);
  }

  createOscillator() {
    return new FakeAudioNode(this);
  }

  createMediaStreamDestination() {
    const node = new FakeAudioNode(this);
    const track = this.world.track("audio", "web-audio");
    this.outputs.push(track);
    node.stream = new FakeStream([track]);
    return node;
  }
}

class FakeEmitter {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: () => void) {
    const wrapped = () => {
      this.off(event, wrapped);
      listener();
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string) {
    [...(this.listeners.get(event) ?? [])].forEach((listener) => listener());
  }
}

export class FakeProducer {
  closed = false;
  paused = false;
  readonly rtpParameters: { codecs: Array<{ mimeType: string }>; encodings: Array<Record<string, unknown>> };
  readonly rtpSender: { getParameters: () => { encodings: Array<Record<string, unknown>> }; setParameters: () => Promise<void> };
  readonly observer = new FakeEmitter();
  private readonly handlers = new Map<string, Set<() => void>>();

  constructor(
    private readonly world: World,
    readonly id: string,
    readonly kind: Kind,
    public track: FakeTrack | null,
    readonly appData: Record<string, unknown>,
    encodings: Array<Record<string, unknown>> | undefined,
  ) {
    const parameters = (encodings ?? [{}]).map((encoding) => ({ ...encoding }));
    this.rtpParameters = {
      codecs: [{ mimeType: kind === "video" ? "video/VP8" : "audio/opus" }],
      encodings: parameters,
    };
    this.rtpSender = {
      getParameters: () => ({ encodings: parameters }),
      setParameters: async () => {
        if (world.refuse("setParameters")) throw new Error("the rig refused setParameters");
      },
    };
    world.producers.push(this);
    world.sent.push({ producer: id, source: track?.source ?? null });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.observer.emit("close");
  }

  async replaceTrack({ track }: { track: FakeTrack | null }) {
    await this.world.wait("replaceTrack");
    if (this.closed) throw new Error("closed");
    if (this.world.refuse("replaceTrack")) throw new Error("the rig refused replaceTrack");
    this.track = track;
    this.world.sent.push({ producer: this.id, source: track?.source ?? null });
  }

  async setRtpEncodingParameters() {
    if (this.world.refuse("setParameters")) throw new Error("the rig refused setParameters");
  }
  async setMaxSpatialLayer() {
    if (this.world.refuse("setParameters")) throw new Error("the rig refused setParameters");
  }

  async getStats() {
    const frames = this.world.framesSent.get(this.id) ?? 0;
    return new Map([
      [
        "out",
        {
          type: "outbound-rtp",
          kind: this.kind,
          framesEncoded: frames,
          framesSent: frames,
          bytesSent: frames * 1000,
          framesPerSecond: 0,
          qualityLimitationReason: "none",
        },
      ],
    ]);
  }

  on(event: string, handler: () => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: () => void) {
    this.handlers.get(event)?.delete(handler);
  }

  closeTransport() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.get("transportclose")?.forEach((handler) => handler());
    this.observer.emit("close");
  }
}

type TransportHandler = (...args: unknown[]) => void;

class FakeTransport {
  closed = false;
  connectionState = "connected";
  readonly appData = {};
  readonly observer = { on() {}, off() {} };
  private connected = false;
  private readonly handlers = new Map<string, TransportHandler>();

  constructor(
    private readonly world: World,
    readonly id: string,
  ) {}

  on(event: string, handler: TransportHandler) {
    this.handlers.set(event, handler);
  }

  off() {}

  close() {
    this.closed = true;
  }

  async restartIce() {}

  async getStats() {
    return new Map();
  }

  async produce(options: {
    track: FakeTrack;
    encodings?: Array<Record<string, unknown>>;
    appData?: Record<string, unknown>;
  }) {
    if (!this.connected) {
      this.connected = true;
      await new Promise<void>((resolve, reject) =>
        this.handlers.get("connect")?.({ dtlsParameters: {} }, resolve, reject),
      );
    }
    await this.world.wait("produce");
    const id = await new Promise<string>((resolve, reject) =>
      this.handlers.get("produce")?.(
        { kind: options.track.kind, rtpParameters: {}, appData: options.appData ?? {} },
        ({ id: producerId }: { id: string }) => {
          this.world.roundTripsInFlight += 1;
          setTimeout(() => {
            this.world.roundTripsInFlight -= 1;
            resolve(producerId);
          }, this.world.produceRoundTripMs);
        },
        reject,
      ),
    );
    if (this.closed) throw new Error("transport closed");
    return new FakeProducer(this.world, id, options.track.kind, options.track, options.appData ?? {}, options.encodings);
  }

  async consume() {
    throw new Error("nothing to consume in this rig");
  }
}

const RTP_CAPABILITIES = {
  codecs: [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 100, parameters: {} },
    { kind: "video", mimeType: "video/VP8", clockRate: 90000, preferredPayloadType: 101, parameters: {} },
  ],
  headerExtensions: [],
};

export const makeDeviceClass = (world: World) =>
  class FakeDevice {
    handlerName = "Chrome111";
    loaded = false;
    rtpCapabilities = RTP_CAPABILITIES;
    sendRtpCapabilities = RTP_CAPABILITIES;
    recvRtpCapabilities = RTP_CAPABILITIES;
    sctpCapabilities = { numStreams: { OS: 1024, MIS: 1024 } };

    async load() {
      this.loaded = true;
    }

    canProduce() {
      return true;
    }

    createSendTransport() {
      return new FakeTransport(world, world.nextId("send"));
    }

    createRecvTransport() {
      return new FakeTransport(world, world.nextId("recv"));
    }
  };

const SFU_ACKS: Record<string, (payload: Record<string, unknown>, world: World) => unknown> = {
  joinRoom: () => ({
    rtpCapabilities: RTP_CAPABILITIES,
    existingProducers: [],
    hostUserId: "host#session",
    hostUserIds: ["host#session"],
    roomId: "test-room",
  }),
  updateMediaCapabilities: () => ({ error: "unsupported in this rig" }),
  createProducerTransport: (_payload, world) => ({
    id: world.nextId("sfu-send"),
    iceParameters: {},
    iceCandidates: [],
    dtlsParameters: {},
  }),
  createConsumerTransport: (_payload, world) => ({
    id: world.nextId("sfu-recv"),
    iceParameters: {},
    iceCandidates: [],
    dtlsParameters: {},
  }),
  produce: (payload, world) => {
    const producerId = world.nextId("producer");
    const appData = (payload.appData ?? {}) as { type?: string; paused?: boolean };
    world.sfu.set(producerId, {
      kind: payload.kind as Kind,
      type: appData.type ?? "webcam",
      paused: appData.paused === true,
      closed: false,
    });
    return { producerId };
  },
  toggleMute: (payload, world) => {
    const producer = world.sfu.get(String(payload.producerId));
    if (!producer || producer.closed) return { error: "Producer not found" };
    producer.paused = payload.paused === true;
    return { success: true };
  },
  toggleCamera: (payload, world) => {
    const producer = world.sfu.get(String(payload.producerId));
    if (!producer || producer.closed) return { error: "Producer not found" };
    producer.paused = payload.paused === true;
    return { success: true };
  },
  closeProducer: (payload, world) => {
    const producer = world.sfu.get(String(payload.producerId));
    if (producer) producer.closed = true;
    return { success: true };
  },
  getProducers: () => ({ producers: [] }),
  syncProducers: () => ({ producers: [] }),
};

const ACK_HOLDS: Partial<Record<string, Hold>> = {
  createConsumerTransport: "consumerTransport",
  toggleMute: "toggleMute",
};

const createSocket = (world: World) => {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const respond = (event: string, args: unknown[], withError: boolean) => {
    const ack = args.at(-1);
    const payload = (typeof args[0] === "object" && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
    world.socketEvents.push({ event, payload });
    if (typeof ack !== "function") return;
    const refusals = world.refusals.get(event) ?? 0;
    if (refusals > 0) world.refusals.set(event, refusals - 1);
    const response =
      refusals > 0 ? { error: `the rig refused ${event}` } : (SFU_ACKS[event]?.(payload, world) ?? { success: true });
    const held = ACK_HOLDS[event];
    void (held ? world.wait(held) : Promise.resolve()).then(() => {
      if (withError) (ack as (error: null, response: unknown) => void)(null, response);
      else (ack as (response: unknown) => void)(response);
    });
  };
  const socket = {
    id: "socket-1",
    connected: false,
    io: { on() {}, off() {}, engine: { on() {}, off() {} }, opts: {} },
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: never[]) => void) => {
      socket.on(event, handler);
      return socket;
    }),
    off: vi.fn((event: string, handler?: (...args: never[]) => void) => {
      if (handler) handlers.get(event)?.delete(handler);
      else handlers.delete(event);
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      respond(event, args, false);
      return socket;
    }),
    timeout: vi.fn(() => ({
      emit: (event: string, ...args: unknown[]) => respond(event, args, true),
    })),
    disconnect: vi.fn(() => {
      socket.connected = false;
      dispatch("disconnect", "io client disconnect");
      return socket;
    }),
    removeAllListeners: vi.fn(() => {
      handlers.clear();
      return socket;
    }),
  };
  const dispatch = (event: string, ...args: unknown[]) => {
    handlers.get(event)?.forEach((handler) => handler(...(args as never[])));
  };
  return { socket, dispatch };
};

let currentWorld: World | null = null;
const activeWorld = () => {
  if (!currentWorld) throw new Error("No rig world is active");
  return currentWorld;
};

const deviceIdOf = (constraint: unknown): string => {
  if (!constraint || typeof constraint !== "object") return "default";
  const deviceId = (constraint as { deviceId?: unknown }).deviceId;
  if (typeof deviceId === "string") return deviceId;
  if (deviceId && typeof deviceId === "object") {
    const exact = (deviceId as { exact?: unknown; ideal?: unknown }).exact ?? (deviceId as { ideal?: unknown }).ideal;
    if (typeof exact === "string") return exact;
  }
  return "default";
};

export const installMediaWorld = (world: World) => {
  currentWorld = world;
  const mediaDevices = {
    getUserMedia: vi.fn(async (constraints?: MediaStreamConstraints) => {
      await world.wait("capture");
      if (world.refuse("getUserMedia")) {
        const error = new Error("the rig refused getUserMedia");
        error.name = "NotReadableError";
        throw error;
      }
      const kinds: Kind[] = [];
      if (constraints?.audio) kinds.push("audio");
      if (constraints?.video) kinds.push("video");
      const failed = kinds.find((kind) => world.failCaptures.includes(kind));
      if (failed) {
        const error = new Error(`${failed} unavailable`);
        error.name = "NotReadableError";
        throw error;
      }
      return new FakeStream(
        kinds.map((kind) => world.track(kind, "device", deviceIdOf(kind === "audio" ? constraints?.audio : constraints?.video))),
      ) as unknown as MediaStream;
    }),
    getDisplayMedia: vi.fn(async () => new FakeStream([world.track("video", "screen")]) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "default", label: "Mic", groupId: "g1" },
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2", groupId: "g2" },
      { kind: "videoinput", deviceId: "default", label: "Camera", groupId: "g3" },
      { kind: "videoinput", deviceId: "cam-2", label: "Camera 2", groupId: "g4" },
    ]),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "devicechange") world.deviceListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "devicechange") world.deviceListeners.delete(listener);
    }),
  };
  Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return mediaDevices;
};

type RigState = ReturnType<typeof useMeetState>;
type RigRefs = ReturnType<typeof useMeetRefs>;
export type RigApi = {
  refs: RigRefs;
  state: RigState;
  media: ReturnType<typeof useMeetMedia>;
  socket: ReturnType<typeof useMeetSocket>;
  setNoiseCancellation: (enabled: boolean) => void;
  setVideoEffects: (count: number) => void;
};

const noop = () => {};
const withDefaults = <T extends object>(supplied: T) =>
  new Proxy(supplied, {
    get: (target, key) =>
      key in target
        ? Reflect.get(target, key)
        : typeof key === "string" && (key.startsWith("set") || key.startsWith("on") || key === "dispatchParticipants" || key === "clearReactions" || key === "addReaction")
          ? noop
          : undefined,
  });

export const createInCallRig = async (world: World, { noiseCancellation = false } = {}) => {
  const { socket, dispatch } = createSocket(world);
  const io = vi.fn(() => {
    setTimeout(() => {
      socket.connected = true;
      dispatch("connect");
    }, 0);
    return socket;
  });
  const Device = makeDeviceClass(world);
  const intervals = new Map<number, { delay: number; callback: () => void }>();
  let intervalCount = 0;
  const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void, delay?: number) => {
    intervalCount += 1;
    intervals.set(intervalCount, { delay: delay ?? 0, callback });
    return intervalCount;
  }) as unknown as typeof window.setInterval);
  const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(((id?: number) => {
    if (id !== undefined) intervals.delete(id);
  }) as typeof window.clearInterval);
  let rig!: RigApi;

  function Client() {
    const refs = useMeetRefs();
    const state = useMeetState({ initialRoomId: "test-room", deviceIntents: refs.deviceIntents });
    const [isNoiseCancellationEnabled, setNoiseCancellation] = useState(noiseCancellation);
    const [activeVideoEffectsCount, setVideoEffects] = useState(0);
    const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] = useState<string | undefined>(undefined);
    const [selectedVideoInputDeviceId, setSelectedVideoInputDeviceId] = useState<string | undefined>(undefined);
    const ensureProducerTransportRef = useRef<(() => Promise<unknown>) | null>(null);
    const republishScreenShareRef = useRef(null);
    const getVideoPublishTrackRef = useRef(null);
    const connectionQualityRef = useRef(null);
    const mediaQualitySettingsRef = useRef(DEFAULT_MEDIA_QUALITY_SETTINGS);
    const effectsActive = activeVideoEffectsCount > 0;
    const rawCamera =
      (state.localStream?.getVideoTracks().find((track) => track.readyState === "live") as unknown as FakeTrack | undefined) ?? null;
    useEffect(() => {
      if (!effectsActive || !rawCamera) return;
      const canvas = {
        captureStream: () => new FakeStream([world.track("video", "effects")]),
      } as unknown as HTMLCanvasElement;
      let output: MediaStreamTrack;
      try {
        [output] = captureHeldCanvas(canvas, 30, captureGeneration()).getVideoTracks();
      } catch {
        return;
      }
      refs.processedVideoTrackRef.current = output;
      return () => {
        output.stop();
        if (refs.processedVideoTrackRef.current === output) refs.processedVideoTrackRef.current = null;
      };
    }, [effectsActive, rawCamera, refs.processedVideoTrackRef]);
    const getVideoPublishTrack = (stream?: MediaStream | null) => {
      const raw =
        stream?.getVideoTracks().find((track) => track.readyState === "live") ??
        refs.localStreamRef.current?.getVideoTracks().find((track) => track.readyState === "live") ??
        null;
      const processed = refs.processedVideoTrackRef.current;
      return effectsActive && raw && processed?.readyState === "live" ? processed : raw;
    };
    (getVideoPublishTrackRef as { current: unknown }).current = getVideoPublishTrack;

    const media = useMeetMedia(
      withDefaults({
        ...state,
        isObserverMode: false,
        deviceIntents: refs.deviceIntents,
        cameraDisabled: false,
        microphoneUnmuteDisabled: false,
        cameraEnableDisabled: false,
        selectedAudioInputDeviceId,
        setSelectedAudioInputDeviceId,
        setSelectedAudioOutputDeviceId: noop,
        selectedVideoInputDeviceId,
        setSelectedVideoInputDeviceId,
        isNoiseCancellationEnabled,
        videoQualityRef: refs.videoQualityRef,
        mediaQualitySettings: DEFAULT_MEDIA_QUALITY_SETTINGS,
        mediaQualitySettingsRef,
        webcamCodecPolicyRef: refs.webcamCodecPolicyRef,
        dataSaverMode: false,
        activeVideoEffectsCount,
        shouldUsePreferredVideoPublishTrack: effectsActive,
        getVideoPublishTrackRef,
        socketRef: refs.socketRef,
        deviceRef: refs.deviceRef,
        producerTransportRef: refs.producerTransportRef,
        ensureProducerTransportRef,
        republishScreenShareRef,
        audioProducerRef: refs.audioProducerRef,
        videoProducerRef: refs.videoProducerRef,
        screenProducerRef: refs.screenProducerRef,
        screenAudioProducerRef: refs.screenAudioProducerRef,
        screenShareStreamRef: refs.screenShareStreamRef,
        screenShareCaptureControllerRef: refs.screenShareCaptureControllerRef,
        intentionalLocalProducerCloseIdsRef: refs.intentionalLocalProducerCloseIdsRef,
        localStreamRef: refs.localStreamRef,
        connectionQualityRef,
        intentionalTrackStopsRef: refs.intentionalTrackStopsRef,
        permissionHintTimeoutRef: refs.permissionHintTimeoutRef,
        audioContextRef: refs.audioContextRef,
        mediaRecoveryBlockedRef: refs.reconnectInFlightRef,
      }) as unknown as Parameters<typeof useMeetMedia>[0],
    );

    const socketApi = useMeetSocket(
      withDefaults({
        ...state,
        refs,
        isAdmin: false,
        userId: "viewer#session",
        getJoinInfo: async () => {
          if (world.joinRefusal) throw new Error(world.joinRefusal);
          return { token: "test-token", sfuUrl: "http://localhost:3031" };
        },
        joinMode: "meeting",
        displayNameInput: "Viewer",
        selectedVideoInputDeviceId,
        getVideoPublishTrack,
        videoQualityRef: refs.videoQualityRef,
        mediaQualitySettingsRef,
        activeVideoEffectsCount,
        connectionQualityRef,
        dataSaverMode: false,
        audioOnlyMode: false,
        isTtsDisabled: false,
        updateVideoQualityRef: media.updateVideoQualityRef,
        requestMediaPermissions: media.requestMediaPermissions,
        requestAudioProducerRecovery: media.requestAudioProducerRecovery,
        requestCameraProducerRecovery: media.requestCameraProducerRecovery,
        prepareAudioPublishTrack: media.prepareAudioPublishTrack,
        stopLocalTrack: media.stopLocalTrack,
        handleLocalTrackEnded: media.handleLocalTrackEnded,
        playNotificationSound: noop,
        primeAudioOutput: noop,
        chat: {
          setChatMessages: noop,
          setChatOverlayMessages: noop,
          setUnreadCount: noop,
          isChatOpenRef: { current: false },
        },
        prewarm: { io, Device, isReady: true },
        bypassMediaPermissions: false,
      }) as unknown as Parameters<typeof useMeetSocket>[0],
    );

    useEffect(() => {
      ensureProducerTransportRef.current = socketApi.ensureProducerTransport as () => Promise<unknown>;
    }, [socketApi.ensureProducerTransport]);

    rig = { refs, state, media, socket: socketApi, setNoiseCancellation, setVideoEffects };
    return null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Client));
  });

  const settle = async (turns = 12) => {
    for (let turn = 0; turn < turns; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  const tick = async (delay: number) => {
    [...intervals.values()].filter((entry) => entry.delay === delay).forEach((entry) => entry.callback());
    await settle();
  };

  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  };

  return { rig: () => rig, socket, dispatch, settle, tick, unmount };
};

export type InCallRig = Awaited<ReturnType<typeof createInCallRig>>;

const reachableTracks = (world: World, rig: RigApi) => {
  const reachable = new Set<FakeTrack>();
  const add = (track: FakeTrack | null | undefined) => {
    if (!track || reachable.has(track)) return;
    reachable.add(track);
    add(getNoiseCancellationSourceTrack(track as unknown as MediaStreamTrack) as unknown as FakeTrack | null);
  };
  (rig.refs.localStreamRef.current?.getTracks() ?? []).forEach((track) => add(track as unknown as FakeTrack));
  world.producers.filter((producer) => !producer.closed).forEach((producer) => add(producer.track));
  add(rig.refs.processedVideoTrackRef.current as unknown as FakeTrack | null);
  return reachable;
};

export const unwanted = (world: World, rig: RigApi): string[] => {
  const intents = rig.refs.deviceIntents.get();
  const problems: string[] = [];
  const reachable = reachableTracks(world, rig);
  const live = world.tracks.filter((track) => track.readyState === "live");
  live.forEach((track) => {
    if (!reachable.has(track)) problems.push(`orphan live ${track.kind} track ${track.id}`);
  });
  const openProducers = world.producers.filter((producer) => !producer.closed);
  (["audio", "video"] as const).forEach((kind) => {
    const open = openProducers.filter((producer) => producer.kind === kind && producer.appData.type !== "screen");
    if (open.length > 1) problems.push(`${open.length} open ${kind} producers: ${open.map((producer) => producer.id).join(", ")}`);
  });
  const openOnSfu = [...world.sfu.entries()].filter(([, producer]) => !producer.closed && producer.type !== "screen");
  openOnSfu.forEach(([id, producer]) => {
    const local = openProducers.find((candidate) => candidate.id === id);
    if (!local) problems.push(`the SFU still has ${producer.kind} producer ${id} that this client closed`);
    else if (local.paused !== producer.paused && producer.kind === "audio") {
      problems.push(`audio producer ${id} is ${local.paused ? "paused" : "live"} here but ${producer.paused ? "paused" : "live"} on the SFU`);
    }
  });
  const liveCameras = live.filter((track) => track.kind === "video" && track.source === "device");
  if (liveCameras.length > 1) problems.push(`${liveCameras.length} live cameras: ${liveCameras.map((track) => track.id).join(", ")}`);
  const streamCameras = new Set(rig.refs.localStreamRef.current?.getVideoTracks() ?? []);
  openProducers
    .filter((producer) => producer.kind === "video" && producer.appData.type !== "screen" && producer.track?.source === "device")
    .forEach((producer) => {
      if (producer.track?.readyState === "live" && !streamCameras.has(producer.track as unknown as MediaStreamTrack)) {
        problems.push(`camera producer ${producer.id} sends ${producer.track.id} but the local stream shows another camera`);
      }
    });
  if (!intents.video.chosen) {
    live
      .filter((track) => track.kind === "video" && track.source !== "screen")
      .forEach((track) => problems.push(`camera is off but ${track.id} is live`));
    openProducers
      .filter((producer) => producer.kind === "video" && producer.appData.type !== "screen")
      .forEach((producer) => problems.push(`camera is off but camera producer ${producer.id} is open`));
  }
  if (!intents.audio.chosen) {
    live
      .filter((track) => track.kind === "audio" && track.enabled)
      .forEach((track) => problems.push(`microphone is off but ${track.id} is enabled`));
    openProducers
      .filter((producer) => producer.kind === "audio" && !producer.paused)
      .forEach((producer) => problems.push(`microphone is off but audio producer ${producer.id} is unpaused`));
    openOnSfu
      .filter(([, producer]) => producer.kind === "audio" && !producer.paused)
      .forEach(([id]) => problems.push(`microphone is off but the SFU has audio producer ${id} live`));
  }
  world.contexts
    .filter((context) => context.state !== "closed")
    .forEach((context, index) => {
      if (!context.outputs.some((track) => track.readyState === "live" && reachable.has(track))) {
        problems.push(`orphan open audio context ${index}`);
      }
    });
  return problems;
};

export const notLive = (world: World, rig: RigApi): string[] => {
  if (rig.state.connectionState !== "joined") return [];
  const intents = rig.refs.deviceIntents.get();
  const problems: string[] = [];
  const open = world.producers.filter((producer) => !producer.closed && producer.appData.type !== "screen");
  const sending = (kind: Kind) =>
    open.filter((producer) => {
      const onSfu = world.sfu.get(producer.id);
      return (
        producer.kind === kind &&
        !producer.paused &&
        producer.track?.readyState === "live" &&
        producer.track.enabled &&
        onSfu !== undefined &&
        !onSfu.closed &&
        !onSfu.paused
      );
    });
  if (intents.audio.chosen && sending("audio").length !== 1) {
    problems.push(`the microphone is on but ${sending("audio").length} audio producers are sending`);
  }
  if (intents.video.chosen && sending("video").length !== 1) {
    problems.push(`the camera is on but ${sending("video").length} camera producers are sending`);
  }
  return problems;
};

export const cameraOffButLive = (world: World, rig: RigApi): string[] =>
  rig.refs.deviceIntents.get().video.chosen
    ? []
    : world.tracks
        .filter((track) => track.kind === "video" && track.source !== "screen" && track.readyState === "live")
        .map((track) => `camera is off but ${track.id} is still live`);

export const leftAfterEnd = (world: World): string[] => [
  ...world.tracks.filter((track) => track.readyState === "live").map((track) => `live ${track.kind} track ${track.id}`),
  ...world.producers.filter((producer) => !producer.closed).map((producer) => `open producer ${producer.id}`),
  ...world.contexts.filter((context) => context.state !== "closed").map((_context, index) => `open audio context ${index}`),
];
