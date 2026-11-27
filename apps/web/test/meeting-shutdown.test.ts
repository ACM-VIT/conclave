import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import { JOIN_REJECTED_MESSAGE } from "../src/app/lib/setup-notice";

const joinInfo = { token: "test-token", sfuUrl: "http://localhost:3031" };

type SocketApi = ReturnType<typeof useMeetSocket>;
type Refs = ReturnType<typeof useMeetRefs>;

const createHarness = (
  getJoinInfo = async () => joinInfo,
  overrides: Partial<Parameters<typeof useMeetSocket>[0]> = {},
) => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    emit: vi.fn(),
    disconnect: vi.fn(() => {
      socket.connected = false;
      dispatch("disconnect", "io client disconnect");
    }),
  };
  const dispatch = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args as never[]);
  const io = vi.fn(() => socket);
  const setConnectionState = vi.fn();
  const setMeetError = vi.fn();
  const setSetupNotice = vi.fn();
  const onLocalRoomEnded = vi.fn();
  let api!: SocketApi;
  let refs!: Refs;
  function Harness() {
    refs = useMeetRefs();
    const noop = () => {};
    const supplied = {
      refs, roomId: "test-room", userId: "viewer#session", localStream: null,
      getJoinInfo, prewarm: { io, Device: null, isReady: true },
      setConnectionState, setMeetError, setSetupNotice, onLocalRoomEnded,
      isMuted: true, isCameraOff: true, displayNameInput: "Viewer",
      primeAudioOutput: () => {},
      chat: { setChatMessages: noop, setChatOverlayMessages: noop, setUnreadCount: noop, isChatOpenRef: { current: false } },
      ...overrides,
    };
    const options = new Proxy(supplied, {
      get: (target, key) => key in target ? Reflect.get(target, key) : typeof key === "string" && (key.startsWith("set") || key === "dispatchParticipants" || key === "clearReactions" || key === "stopLocalTrack") ? noop : undefined,
    }) as unknown as Parameters<typeof useMeetSocket>[0];
    api = useMeetSocket(options);
    return null;
  }
  renderToString(createElement(Harness));
  const connect = async () => {
    const pending = api.connectSocket("test-room");
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
    socket.connected = true;
    dispatch("connect");
    await pending;
    refs.currentRoomIdRef.current = "test-room";
  };
  return { api, refs, socket, io, connect, dispatch, setConnectionState, setMeetError, setSetupNotice, onLocalRoomEnded };
};

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
});
afterEach(() => vi.unstubAllGlobals());

describe("intentional meeting shutdown", () => {
  it("keeps the host-ended notice after a late socket error", async () => {
    const h = createHarness();
    await h.connect();
    h.dispatch("roomEnded", { endedBy: "host#session" });
    h.dispatch("connect_error", new Error("transport closed"));
    expect(h.refs.intentionalDisconnectRef.current).toBe(true);
    expect(h.setConnectionState).toHaveBeenLastCalledWith("disconnected");
    expect(h.setMeetError).toHaveBeenLastCalledWith(null);
    expect(h.setSetupNotice).toHaveBeenLastCalledWith({
      kind: "ended",
      message: "The host ended this meeting. You are no longer connected.",
    });
    expect(h.refs.currentRoomIdRef.current).toBeNull();
  });

  it("finishes the local host only once when end notification is repeated", async () => {
    const h = createHarness();
    await h.connect();
    h.dispatch("roomEnded", { endedBy: "viewer#session" });
    h.dispatch("roomEnded", { endedBy: "viewer#session" });
    expect(h.onLocalRoomEnded).toHaveBeenCalledOnce();
    expect(h.setConnectionState).toHaveBeenLastCalledWith("disconnected");
  });

  it("does not open a new socket when join information arrives after leaving", async () => {
    let resolveJoinInfo!: (value: typeof joinInfo) => void;
    const h = createHarness(() => new Promise(resolve => { resolveJoinInfo = resolve; }));
    const pending = h.api.connectSocket("test-room");
    const rejection = expect(pending).rejects.toThrow("cancelled");
    h.api.cleanup();
    resolveJoinInfo(joinInfo);
    await rejection;
    expect(h.io).not.toHaveBeenCalled();
    expect(h.setConnectionState).toHaveBeenLastCalledWith("disconnected");
    expect(h.setMeetError).not.toHaveBeenCalled();
  });
});

describe("a host rejecting a waiting guest", () => {
  it("shows the rejection on setup and leaves the meeting until the guest joins again", async () => {
    const setWaitingMessage = vi.fn();
    const h = createHarness(async () => joinInfo, { setWaitingMessage });
    await h.connect();
    h.dispatch("joinRejected");
    expect(h.setSetupNotice).toHaveBeenLastCalledWith({ kind: "rejected", message: JOIN_REJECTED_MESSAGE });
    expect(h.setMeetError).toHaveBeenLastCalledWith(expect.objectContaining({ code: "JOIN_REJECTED" }));
    expect(h.setConnectionState).toHaveBeenCalledWith("error");
    expect(setWaitingMessage).toHaveBeenLastCalledWith(null);
    expect(h.socket.disconnect).toHaveBeenCalled();
    expect(h.refs.intentionalDisconnectRef.current).toBe(true);

    void h.api.joinRoomById("test-room");
    await vi.waitFor(() => expect(h.setSetupNotice).toHaveBeenLastCalledWith(null));
    h.api.cleanup();
  });

  it("keeps the ended notice when a rejection arrives in the same batch after the meeting ended", async () => {
    const h = createHarness();
    await h.connect();
    h.dispatch("roomEnded", { endedBy: "host#session" });
    h.dispatch("joinRejected");
    expect(h.setSetupNotice).toHaveBeenLastCalledWith({
      kind: "ended",
      message: "The host ended this meeting. You are no longer connected.",
    });
    expect(h.setMeetError).not.toHaveBeenCalledWith(expect.objectContaining({ code: "JOIN_REJECTED" }));
  });

  it("keeps a host ending in one place: the end screen when it takes it, else the setup notice", async () => {
    const shown = createHarness(async () => joinInfo, { onCallEnded: () => true });
    await shown.connect();
    shown.dispatch("roomEnded", { endedBy: "host#session", message: "Thanks, everyone" });
    expect(shown.setSetupNotice).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "ended" }));

    const onCallEnded = vi.fn(() => false);
    const notShown = createHarness(async () => joinInfo, { onCallEnded });
    await notShown.connect();
    notShown.dispatch("roomEnded", { endedBy: "host#session", message: "Thanks, everyone" });
    expect(onCallEnded).toHaveBeenCalledWith({ kind: "endedByHost", detail: "Thanks, everyone" });
    expect(notShown.setSetupNotice).toHaveBeenLastCalledWith({ kind: "ended", message: "Thanks, everyone" });
  });
});

const createAudioStream = (id: string) => {
  const stop = vi.fn();
  const track = {
    id, kind: "audio", readyState: "live", enabled: true, muted: false,
    getSettings: () => ({}), stop,
  } as unknown as MediaStreamTrack;
  const stream = {
    id, getTracks: () => [track], getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
  return { stream, track, stop };
};

it("does not reacquire a muted microphone after prejoin skips warmup", async () => {
  const requestMediaPermissions = vi.fn(async () => null);
  const h = createHarness(async () => joinInfo, { requestMediaPermissions });
  h.refs.skipMutedMicWarmupRef.current = true;
  const join = h.api.joinRoomById("test-room");
  try {
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledOnce());
    expect(requestMediaPermissions).not.toHaveBeenCalled();
  } finally {
    h.dispatch("connect_error", new Error("The test connection closed"));
    await join;
    h.api.cleanup();
  }
});

describe("media acquisition during shutdown", () => {
  it("releases a microphone granted after leaving without restoring meeting state", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const media = createAudioStream("late-microphone");
    const setLocalStream = vi.fn();
    const h = createHarness(async () => joinInfo, {
      isMuted: false,
      requestMediaPermissions: () => new Promise(resolve => { resolveMedia = resolve; }),
      stopLocalTrack: track => track?.stop(),
      setLocalStream,
    });
    const join = h.api.joinRoomById("test-room");
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledOnce());
    h.socket.connected = true;
    h.dispatch("connect");
    h.api.cleanup();
    resolveMedia(media.stream);
    await join;
    expect(media.stop).toHaveBeenCalledOnce();
    expect(h.refs.localStreamRef.current).toBeNull();
    expect(setLocalStream).toHaveBeenLastCalledWith(null);
    expect(h.setConnectionState).toHaveBeenLastCalledWith("disconnected");
    expect(h.setMeetError).toHaveBeenLastCalledWith(null);
    expect(h.socket.emit).not.toHaveBeenCalledWith("joinRoom", expect.anything(), expect.anything());
  });

  it("preserves media owned by a subsequent join when the old request finishes", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const oldMedia = createAudioStream("old-microphone");
    const newMedia = createAudioStream("new-microphone");
    const h = createHarness(async () => joinInfo, {
      isMuted: false,
      requestMediaPermissions: () => new Promise(resolve => { resolveMedia = resolve; }),
      stopLocalTrack: track => track?.stop(),
    });
    const join = h.api.joinRoomById("test-room");
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledOnce());
    h.socket.connected = true;
    h.dispatch("connect");
    h.api.cleanup();
    h.refs.intentionalDisconnectRef.current = false;
    h.refs.localStreamRef.current = newMedia.stream;
    resolveMedia({
      getTracks: () => [oldMedia.track, newMedia.track],
    } as unknown as MediaStream);
    await join;
    expect(oldMedia.stop).toHaveBeenCalledOnce();
    expect(newMedia.stop).not.toHaveBeenCalled();
    expect(h.refs.localStreamRef.current).toBe(newMedia.stream);
  });

  it("releases late media even when socket setup already rejected after leaving", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    let resolveJoinInfo!: (value: typeof joinInfo) => void;
    const media = createAudioStream("late-microphone");
    const h = createHarness(
      () => new Promise(resolve => { resolveJoinInfo = resolve; }),
      {
        isMuted: false,
        requestMediaPermissions: () => new Promise(resolve => { resolveMedia = resolve; }),
        stopLocalTrack: track => track?.stop(),
      },
    );
    const join = h.api.joinRoomById("test-room");
    h.api.cleanup();
    resolveJoinInfo(joinInfo);
    await join;
    resolveMedia(media.stream);
    await vi.waitFor(() => expect(media.stop).toHaveBeenCalledOnce());
    expect(h.refs.localStreamRef.current).toBeNull();
    expect(h.io).not.toHaveBeenCalled();
    expect(h.setConnectionState).toHaveBeenLastCalledWith("disconnected");
  });

  it("stops the current stream even before React has committed its state", () => {
    const media = createAudioStream("newly-acquired");
    const h = createHarness(async () => joinInfo, {
      stopLocalTrack: track => track?.stop(),
    });
    h.refs.localStreamRef.current = media.stream;
    h.api.cleanup();
    expect(media.stop).toHaveBeenCalledOnce();
    expect(h.refs.localStreamRef.current).toBeNull();
  });
});
