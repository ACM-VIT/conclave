// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useLocalCameraPreview,
  type LocalCameraPreviewController,
} from "../src/app/hooks/useLocalCameraPreview";
import { useMeetMedia } from "../src/app/hooks/useMeetMedia";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import { useMicTest } from "../src/app/hooks/useMicTest";
import { publishIntent, setDeviceOff } from "../src/app/lib/device-intent";
import { createNoiseCancellationPipeline } from "../src/app/lib/noise-cancellation";
import { getUserMediaWithTimeout } from "../src/app/lib/media-capture-timeout";
import { DEFAULT_MEDIA_QUALITY_SETTINGS } from "../src/app/lib/media-quality-settings";

vi.mock(import("../src/app/lib/noise-cancellation"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, createNoiseCancellationPipeline: vi.fn(original.createNoiseCancellationPipeline) };
});

type SocketApi = ReturnType<typeof useMeetSocket>;
type Refs = ReturnType<typeof useMeetRefs>;
type Rig = {
  api: SocketApi;
  refs: Refs;
  preview: LocalCameraPreviewController;
  mediaRefs: Refs;
  media: ReturnType<typeof useMeetMedia>;
};

class FakeTrack {
  readyState: MediaStreamTrackState = "live";
  enabled = true;
  muted = false;
  onended: (() => void) | null = null;
  constructor(readonly id: string, readonly kind: "audio" | "video", readonly source: string) {}
  stop() {
    this.readyState = "ended";
  }
  getSettings() {
    return {};
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeStream {
  readonly id: string;
  constructor(private readonly tracks: FakeTrack[] = []) {
    this.id = `stream-${tracks.map((track) => track.id).join("+")}`;
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
}

class FakeNode {
  gain = { value: 1 };
  fftSize = 0;
  smoothingTimeConstant = 0;
  stream = new FakeStream();
  connect() {}
  disconnect() {}
  getFloatTimeDomainData() {}
}

class FakeAudioContext {
  state = "running";
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  createGain() {
    return new FakeNode();
  }
  createAnalyser() {
    return new FakeNode();
  }
  createMediaStreamDestination() {
    const node = new FakeNode();
    trackCount += 1;
    const track = new FakeTrack(`derived-audio-${trackCount}`, "audio", "derived");
    created.push(track);
    node.stream = new FakeStream([track]);
    return node;
  }
}

const created: FakeTrack[] = [];
const waiting: Array<() => void> = [];
let holdRequests = false;
let joinRefusal: string | null = null;
let holdJoins = false;
let trackCount = 0;

const capture = (source: string, kinds: Array<"audio" | "video">) =>
  new Promise<MediaStream>((resolve) => {
    const grant = () => {
      const tracks = kinds.map((kind) => {
        trackCount += 1;
        const track = new FakeTrack(`${source}-${kind}-${trackCount}`, kind, source);
        created.push(track);
        return track;
      });
      resolve(new FakeStream(tracks) as unknown as MediaStream);
    };
    if (holdRequests) waiting.push(grant);
    else grant();
  });

const requestedKinds = (constraints: MediaStreamConstraints | DisplayMediaStreamOptions | undefined) => {
  const kinds: Array<"audio" | "video"> = [];
  if (constraints?.audio) kinds.push("audio");
  if (constraints?.video) kinds.push("video");
  return kinds;
};

const sourceOf = (constraints: MediaStreamConstraints | undefined) => {
  const video = constraints?.video;
  if (video && typeof video === "object" && "width" in video) return "settings-preview";
  if (constraints?.audio && !constraints.video && typeof constraints.audio === "object") return "mic-test";
  return "meeting";
};

const fakeDevices = {
  getUserMedia: vi.fn((constraints?: MediaStreamConstraints) =>
    capture(sourceOf(constraints), requestedKinds(constraints)),
  ),
  getDisplayMedia: vi.fn((options?: DisplayMediaStreamOptions) =>
    capture("screen-share", requestedKinds(options)),
  ),
  enumerateDevices: vi.fn(async () => []),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

const liveTracks = () =>
  created.filter((track) => track.readyState === "live").map((track) => track.id);

const createRig = async ({ connect = true, noiseCancellation = false } = {}) => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const states: string[] = [];
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    emit: vi.fn(),
    timeout: vi.fn(() => ({
      emit: (event: string, ...args: unknown[]) => {
        const ack = args.at(-1);
        if (event === "admin:endRoom" && typeof ack === "function") {
          (ack as (error: null, response: { success: boolean }) => void)(null, { success: true });
        }
      },
    })),
    disconnect: vi.fn(() => {
      socket.connected = false;
      handlers.get("disconnect")?.(...(["io client disconnect"] as never[]));
    }),
  };
  const dispatch = (event: string, ...args: unknown[]) => handlers.get(event)?.(...(args as never[]));
  const io = vi.fn(() => socket);
  let rig!: Rig;
  let inCall = true;
  let micTest: ReturnType<typeof useMicTest> | undefined;

  function CallSettingsPanel() {
    micTest = useMicTest({ active: true, noiseCancellation: false });
    return null;
  }

  function Client() {
    const refs = useMeetRefs();
    const preview = useLocalCameraPreview({});
    const noop = () => {};
    const supplied = {
      refs,
      roomId: "test-room",
      userId: "viewer#session",
      localStream: null,
      getJoinInfo: async () => {
        if (holdJoins) return new Promise<never>(() => {});
        if (joinRefusal) throw new Error(joinRefusal);
        return { token: "test-token", sfuUrl: "http://localhost:3031" };
      },
      setConnectionState: (state: string) => states.push(state),
      prewarm: { io, Device: null, isReady: true },
      isMuted: true,
      isCameraOff: true,
      displayNameInput: "Viewer",
      primeAudioOutput: noop,
      stopLocalTrack: (track?: MediaStreamTrack | null) => track?.stop(),
      requestMediaPermissions: (...args: Parameters<Rig["media"]["requestMediaPermissions"]>) =>
        rig.media.requestMediaPermissions(...args),
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
          : typeof key === "string" &&
              (key.startsWith("set") || key.startsWith("on") || key === "dispatchParticipants" || key === "clearReactions")
            ? noop
            : undefined,
    }) as unknown as Parameters<typeof useMeetSocket>[0];
    const api = useMeetSocket(options);
    const mediaRefs = useMeetRefs();
    const mediaOptions = new Proxy(
      {
        ...mediaRefs,
        connectionState: "disconnected",
        isMuted: false,
        isCameraOff: false,
        localStream: null,
        isNoiseCancellationEnabled: noiseCancellation,
        setIsCameraOff: (off: boolean) => setDeviceOff(mediaRefs.deviceIntents, "video", off),
        mediaQualitySettings: DEFAULT_MEDIA_QUALITY_SETTINGS,
        mediaQualitySettingsRef: { current: DEFAULT_MEDIA_QUALITY_SETTINGS },
      },
      {
        get: (target, key) =>
          key in target
            ? Reflect.get(target, key)
            : typeof key === "string" && (key.startsWith("set") || key.startsWith("on"))
              ? noop
              : undefined,
      },
    ) as unknown as Parameters<typeof useMeetMedia>[0];
    const media = useMeetMedia(mediaOptions);
    rig = { api, refs, preview, media, mediaRefs };
    return inCall ? createElement(CallSettingsPanel) : null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Client));
  });
  if (connect) {
    await act(async () => {
      const pending = rig.api.connectSocket("test-room");
      await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
      socket.connected = true;
      dispatch("connect");
      await pending;
    });
    rig.refs.currentRoomIdRef.current = "test-room";
  }

  const showEndScreen = async () => {
    inCall = false;
    await act(async () => {
      root.render(createElement(Client));
    });
  };
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  const drop = async () => {
    socket.connected = false;
    handlers.get("disconnect")?.(...(["transport close"] as never[]));
    await vi.waitFor(() => expect(states).toContain("error"), { timeout: 15_000 });
  };
  return { rig: () => rig, micTest: () => micTest, dispatch, drop, showEndScreen, unmount };
};

type Ending = [
  string,
  (rig: Rig, dispatch: (event: string, ...args: unknown[]) => void, drop: () => Promise<void>) => unknown,
];

const ENDINGS: Ending[] = [
  ["leaving, or a reconnect that gave up", (rig) => rig.api.cleanup()],
  ["ending the call for everyone", (rig) => rig.api.endRoomForEveryone()],
  ["the room ended by this user elsewhere", (_rig, dispatch) => dispatch("roomEnded", { endedBy: "viewer#session" })],
  ["the host ending the meeting, also for a webinar viewer", (_rig, dispatch) => dispatch("roomEnded", { endedBy: "host#session" })],
  ["being removed", (_rig, dispatch) => dispatch("kicked", { reason: "Removed by the host" })],
  ["the room closing", (_rig, dispatch) => dispatch("roomClosed", { reason: "server shutdown" })],
  ["entry being refused", (_rig, dispatch) => dispatch("joinRejected")],
  [
    "a reconnect refused for good",
    async (_rig, _dispatch, drop) => {
      joinRefusal = "Guests are not allowed in this meeting.";
      await drop();
    },
  ],
];

let current: Awaited<ReturnType<typeof createRig>> | null = null;

beforeEach(() => {
  created.length = 0;
  waiting.length = 0;
  holdRequests = false;
  joinRefusal = null;
  holdJoins = false;
  Object.defineProperty(navigator, "mediaDevices", { value: fakeDevices, configurable: true });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("every way a call ends with the client still mounted", () => {
  it("a permanently refused reconnect stops the microphone test without closing Settings", async () => {
    const close = vi.spyOn(FakeAudioContext.prototype, "close");
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    try {
      current = await createRig();
      await vi.waitFor(() => expect(current?.micTest()?.isRunning).toBe(true));

      joinRefusal = "Guests are not allowed in this meeting.";
      await act(async () => current!.drop());

      expect({
        running: current.micTest()?.isRunning,
        starting: current.micTest()?.isStarting,
        recordingStream: current.micTest()?.getRecordingStream(),
        contextCloses: close.mock.calls.length,
        cancelledFrames: cancelFrame.mock.calls.length,
        liveTracks: liveTracks(),
      }).toEqual({
        running: false,
        starting: false,
        recordingStream: null,
        contextCloses: 1,
        cancelledFrames: 1,
        liveTracks: [],
      });
    } finally {
      close.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it.each(ENDINGS)("%s stops every live capture, the settings camera preview included", async (_name, end) => {
    current = await createRig();
    const rig = current.rig();
    rig.refs.localStreamRef.current = await getUserMediaWithTimeout(
      { audio: true, video: true },
      { label: "Meeting media", timeoutMs: 60000 },
    );
    rig.refs.screenShareStreamRef.current = await navigator.mediaDevices.getDisplayMedia({ video: true });
    await act(async () => rig.preview.start());
    await vi.waitFor(() => expect(current?.rig().preview.stream).not.toBeNull());
    await vi.waitFor(() => expect(created.map((track) => track.source)).toContain("mic-test"));
    expect(new Set(created.map((track) => track.source))).toEqual(
      new Set(["meeting", "screen-share", "settings-preview", "mic-test", "derived"]),
    );

    await act(async () => {
      await end(current!.rig(), current!.dispatch, current!.drop);
    });
    await current.showEndScreen();

    expect(liveTracks()).toEqual([]);
    expect(current.rig().preview.stream).toBeNull();
  });

  it.each(ENDINGS)("%s stops every capture still waiting for permission when it is granted later", async (_name, end) => {
    holdRequests = true;
    current = await createRig();
    const rig = current.rig();
    const meeting = getUserMediaWithTimeout(
      { audio: true, video: true },
      { label: "Meeting media", timeoutMs: 60000 },
    ).catch(() => null);
    await act(async () => rig.preview.start());
    await vi.waitFor(() => expect(waiting).toHaveLength(3));

    await act(async () => {
      await end(current!.rig(), current!.dispatch, current!.drop);
    });
    await current.showEndScreen();
    await act(async () => {
      waiting.splice(0).forEach((grant) => grant());
      await meeting;
    });

    expect(new Set(created.map((track) => track.source))).toEqual(
      new Set(["meeting", "settings-preview", "mic-test"]),
    );
    expect(liveTracks()).toEqual([]);
    expect(current.rig().preview.stream).toBeNull();
  });

  it.each(ENDINGS)("%s stops a combined microphone and camera request and tries none of its fallbacks", async (_name, end) => {
    current = await createRig();
    holdRequests = true;
    const requestsBefore = fakeDevices.getUserMedia.mock.calls.length;
    const request = current.rig().media.requestMediaPermissions({
      audio: true,
      video: true,
      audioRequired: true,
      videoRequired: true,
    });
    await vi.waitFor(() => expect(waiting).toHaveLength(1));

    await act(async () => {
      await end(current!.rig(), current!.dispatch, current!.drop);
    });
    await current.showEndScreen();
    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        waiting.splice(0).forEach((grant) => grant());
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(liveTracks()).toEqual([]);
    }
    await act(async () => {
      await request;
    });

    expect(liveTracks()).toEqual([]);
    expect(fakeDevices.getUserMedia.mock.calls.length - requestsBefore).toBe(1);
  });
});

describe("a first join refused before entry, then tried again", () => {
  it.each([
    ["for now", "Connection timeout"],
    ["for good", "Guests are not allowed in this meeting."],
  ])("refused %s: the retry shows and publishes the microphone and camera off and opens no camera", async (_name, reason) => {
    current = await createRig({ connect: false });
    await act(async () => {
      current!.rig().refs.deviceIntents.dispatch({ type: "set", audio: true, video: true });
    });
    joinRefusal = reason;
    await act(async () => {
      await current!.rig().api.joinRoom();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(publishIntent(current.rig().refs.deviceIntents.get())).toEqual({ isMicOn: false, isCameraOn: false });
    expect(liveTracks()).toEqual([]);

    const requestsBefore = fakeDevices.getUserMedia.mock.calls.length;
    joinRefusal = null;
    holdJoins = true;
    await act(async () => {
      void current!.rig().api.joinRoom();
      await vi.waitFor(() => expect(fakeDevices.getUserMedia.mock.calls.length).toBeGreaterThan(requestsBefore));
    });

    const retried = fakeDevices.getUserMedia.mock.calls
      .slice(requestsBefore)
      .map(([constraints]) => requestedKinds(constraints));
    expect(retried).toEqual([["audio"]]);
    expect(publishIntent(current.rig().refs.deviceIntents.get())).toEqual({ isMicOn: false, isCameraOn: false });
  });
});

it("a reconnect waiting for microphone processing cannot turn a replacement camera off", async () => {
  current = await createRig({ connect: false, noiseCancellation: true });
  const { media, mediaRefs } = current.rig();
  const oldCamera = new FakeTrack("first-camera", "video", "meeting");
  const newerCamera = new FakeTrack("replacement-camera", "video", "meeting");
  mediaRefs.deviceIntents.dispatch({ type: "set", audio: true, video: true });
  mediaRefs.localStreamRef.current = new FakeStream([oldCamera]) as unknown as MediaStream;

  const pipeline = vi.mocked(createNoiseCancellationPipeline);
  let finishAudio: (() => void) | undefined;
  pipeline.mockImplementationOnce((track) => new Promise((resolve) => {
    finishAudio = () => resolve({ outputTrack: track } as Awaited<ReturnType<typeof createNoiseCancellationPipeline>>);
  }));

  await act(async () => {
    const refreshing = media.requestMediaPermissions({ audio: true, video: true, videoRequired: true });
    await vi.waitFor(() => expect(finishAudio).toBeTypeOf("function"));
    mediaRefs.deviceIntents.dispatch({ type: "choose", device: "video", chosen: false });
    oldCamera.stop();
    const newer = mediaRefs.deviceIntents.dispatch({ type: "capture", device: "video" }).video;
    mediaRefs.localStreamRef.current = new FakeStream([newerCamera]) as unknown as MediaStream;
    mediaRefs.deviceIntents.dispatch({ type: "settle", device: "video", request: newer.request, chosen: true });
    finishAudio?.();
    await refreshing;
  });

  expect(publishIntent(mediaRefs.deviceIntents.get()).isCameraOn).toBe(true);
  expect(mediaRefs.localStreamRef.current?.getVideoTracks()).toEqual([newerCamera]);
  expect(newerCamera.readyState).toBe("live");
});
