// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useLocalCameraPreview,
  type LocalCameraPreviewController,
} from "../src/app/hooks/useLocalCameraPreview";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import { useMicTest } from "../src/app/hooks/useMicTest";
import { getUserMediaWithTimeout } from "../src/app/lib/media-capture-timeout";

type SocketApi = ReturnType<typeof useMeetSocket>;
type Refs = ReturnType<typeof useMeetRefs>;
type Rig = { api: SocketApi; refs: Refs; preview: LocalCameraPreviewController };

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
    return new FakeNode();
  }
}

const created: FakeTrack[] = [];
const waiting: Array<() => void> = [];
let holdRequests = false;
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

const createRig = async () => {
  const handlers = new Map<string, (...args: never[]) => void>();
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

  function CallSettingsPanel() {
    useMicTest({ active: true, noiseCancellation: false });
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
      getJoinInfo: async () => ({ token: "test-token", sfuUrl: "http://localhost:3031" }),
      prewarm: { io, Device: null, isReady: true },
      isMuted: true,
      isCameraOff: true,
      displayNameInput: "Viewer",
      primeAudioOutput: noop,
      stopLocalTrack: (track?: MediaStreamTrack | null) => track?.stop(),
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
    rig = { api, refs, preview };
    return inCall ? createElement(CallSettingsPanel) : null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Client));
  });
  await act(async () => {
    const pending = rig.api.connectSocket("test-room");
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
    socket.connected = true;
    dispatch("connect");
    await pending;
  });
  rig.refs.currentRoomIdRef.current = "test-room";

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
  return { rig: () => rig, dispatch, showEndScreen, unmount };
};

type Ending = [string, (rig: Rig, dispatch: (event: string, ...args: unknown[]) => void) => unknown];

const ENDINGS: Ending[] = [
  ["leaving, or a reconnect that gave up", (rig) => rig.api.cleanup()],
  ["ending the call for everyone", (rig) => rig.api.endRoomForEveryone()],
  ["the room ended by this user elsewhere", (_rig, dispatch) => dispatch("roomEnded", { endedBy: "viewer#session" })],
  ["the host ending the meeting, also for a webinar viewer", (_rig, dispatch) => dispatch("roomEnded", { endedBy: "host#session" })],
  ["being removed", (_rig, dispatch) => dispatch("kicked", { reason: "Removed by the host" })],
  ["the room closing", (_rig, dispatch) => dispatch("roomClosed", { reason: "server shutdown" })],
  ["entry being refused", (_rig, dispatch) => dispatch("joinRejected")],
];

let current: Awaited<ReturnType<typeof createRig>> | null = null;

beforeEach(() => {
  created.length = 0;
  waiting.length = 0;
  holdRequests = false;
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
      new Set(["meeting", "screen-share", "settings-preview", "mic-test"]),
    );

    await act(async () => {
      await end(current!.rig(), current!.dispatch);
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
      await end(current!.rig(), current!.dispatch);
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
});
