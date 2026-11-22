import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";

type Options = Parameters<typeof useMeetSocket>[0];
type JoinInfo = Awaited<ReturnType<Options["getJoinInfo"]>>;

const tokenFor = (roomId: string) => `token-for-${roomId}`;

// The socket hook with a fake socket.io. `adoptJoinIdentity` stands in for
// the page: it answers whether the token names an identity the page has not
// taken yet.
const createHarness = (
  overrides: Partial<Options> & {
    getJoinInfo?: Options["getJoinInfo"];
  } = {},
) => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    emit: vi.fn(),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  const io = vi.fn((_url: string, _options: { auth: { token: string } }) => socket);
  const getJoinInfo = vi.fn(
    overrides.getJoinInfo ??
      (async (roomId: string): Promise<JoinInfo> => ({
        token: tokenFor(roomId),
        sfuUrl: "http://localhost:3031",
      })),
  );
  let api!: ReturnType<typeof useMeetSocket>;
  function Harness() {
    const refs = useMeetRefs();
    (overrides as { captureRefs?: (captured: typeof refs) => void }).captureRefs?.(refs);
    const noop = () => {};
    const supplied = {
      refs, roomId: "room-a", userId: "guest-before#session", localStream: null,
      prewarm: { io, Device: null, isReady: true },
      isMuted: true, isCameraOff: true, displayNameInput: "Viewer",
      primeAudioOutput: noop,
      chat: { setChatMessages: noop, setChatOverlayMessages: noop, setUnreadCount: noop, isChatOpenRef: { current: false } },
      ...overrides,
      getJoinInfo,
    };
    const options = new Proxy(supplied, {
      get: (target, key) => key in target ? Reflect.get(target, key) : typeof key === "string" && (key.startsWith("set") || key === "dispatchParticipants" || key === "clearReactions" || key === "stopLocalTrack") ? noop : undefined,
    }) as unknown as Options;
    api = useMeetSocket(options);
    return null;
  }
  renderToString(createElement(Harness));
  // Starts a connection and, once the hook has opened a socket, lets it connect.
  const connect = async (roomId: string, opened: number) => {
    const pending = api.connectSocket(roomId);
    await vi.waitFor(() => expect(io).toHaveBeenCalledTimes(opened));
    socket.connected = true;
    handlers.get("connect")?.(...([] as never[]));
    await pending;
  };
  const tokenOfSocket = (call: number) => io.mock.calls[call][1].auth.token;
  return { api, socket, io, getJoinInfo, connect, tokenOfSocket };
};

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
});
afterEach(() => vi.unstubAllGlobals());

describe("the identity a socket is opened as", () => {
  it("is never one the page has not taken: the connect stops, and the same token is used once it has", async () => {
    const adoptJoinIdentity = vi.fn<(token: string, roomId: string) => boolean>(() => true);
    const h = createHarness({ adoptJoinIdentity });

    await expect(h.api.connectSocket("room-a")).rejects.toThrow("another identity");
    expect(adoptJoinIdentity).toHaveBeenCalledWith(tokenFor("room-a"), "room-a");
    expect(h.io).not.toHaveBeenCalled();

    adoptJoinIdentity.mockReturnValue(false);
    await h.connect("room-a", 1);

    expect(h.tokenOfSocket(0)).toBe(tokenFor("room-a"));
    expect(h.getJoinInfo).toHaveBeenCalledTimes(1);
  });

  it("is not a provisional one after the token could not be fetched", async () => {
    const adoptJoinIdentity = vi.fn(() => false);
    let fail = true;
    const h = createHarness({
      adoptJoinIdentity,
      getJoinInfo: async (roomId) => {
        if (fail) throw new Error("join route unreachable");
        return { token: tokenFor(roomId), sfuUrl: "http://localhost:3031" };
      },
    });

    await expect(h.api.connectSocket("room-a")).rejects.toThrow("join route unreachable");
    expect(h.io).not.toHaveBeenCalled();
    expect(adoptJoinIdentity).not.toHaveBeenCalled();

    fail = false;
    await h.connect("room-a", 1);
    expect(adoptJoinIdentity).toHaveBeenCalledWith(tokenFor("room-a"), "room-a");
  });
});

describe("a socket that is still open after a join failed", () => {
  it("is reused for the same room", async () => {
    const h = createHarness({ adoptJoinIdentity: () => false });
    await h.connect("room-a", 1);

    await h.api.connectSocket("room-a");

    expect(h.io).toHaveBeenCalledTimes(1);
    expect(h.getJoinInfo).toHaveBeenCalledTimes(1);
  });

  it("is replaced, with that room's own token, when the room code is corrected", async () => {
    const adoptJoinIdentity = vi.fn(() => false);
    const h = createHarness({ adoptJoinIdentity });
    await h.connect("room-a", 1);

    await h.connect("room-b", 2);

    expect(h.socket.disconnect).toHaveBeenCalled();
    expect(h.tokenOfSocket(1)).toBe(tokenFor("room-b"));
    expect(adoptJoinIdentity).toHaveBeenLastCalledWith(tokenFor("room-b"), "room-b");
  });
});

describe("a join that starts over under the identity its token named", () => {
  const capture = (id: string) => {
    const track = { id, kind: "audio", readyState: "live", stop: vi.fn() };
    const stream = {
      id,
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    return { track, stream };
  };

  it("asks for the microphone once, and leaves no capture outside the page's stream", async () => {
    const adoptJoinIdentity = vi.fn(() => false).mockReturnValueOnce(true);
    const answerCapture: Array<(stream: MediaStream) => void> = [];
    const captures = [capture("first"), capture("second")];
    const requestMediaPermissions = vi.fn(
      () => new Promise<MediaStream>((resolve) => answerCapture.push(resolve)),
    );
    let pageStream: MediaStream | null = null;
    const setLocalStream = vi.fn((next: MediaStream | null | ((current: MediaStream | null) => MediaStream | null)) => {
      pageStream = typeof next === "function" ? next(pageStream) : next;
    });
    const stopLocalTrack = vi.fn();
    const h = createHarness({ adoptJoinIdentity, requestMediaPermissions, setLocalStream, stopLocalTrack });

    await h.api.joinRoomById("room-a");
    expect(answerCapture).toHaveLength(1);
    const rejoined = h.api.joinRoomById("room-a");
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledTimes(1));
    answerCapture.forEach((answer, index) => answer(captures[index].stream));
    await vi.waitFor(() => expect(setLocalStream).toHaveBeenCalled());
    const failSocket = h.socket.on.mock.calls.find(([name]) => name === "connect_error")?.[1];
    failSocket?.(...([new Error("the signaling connection closed")] as never[]));
    await rejoined;

    expect(requestMediaPermissions).toHaveBeenCalledTimes(1);
    expect(stopLocalTrack).toHaveBeenCalledWith(captures[0].track);
    expect(pageStream).toBeNull();
  });
});

describe("a reconnect that starts over under the identity its token named", () => {
  it("keeps the codes and the name the meeting was joined with", async () => {
    const adoptJoinIdentity = vi.fn(() => false).mockReturnValueOnce(true);
    let refs!: ReturnType<typeof useMeetRefs>;
    const h = createHarness({
      adoptJoinIdentity,
      joinMode: "webinar_attendee",
      bypassMediaPermissions: true,
      captureRefs: (captured: ReturnType<typeof useMeetRefs>) => {
        refs = captured;
      },
    } as Partial<Options>);
    refs.joinOptionsRef.current = {
      joinMode: "webinar_attendee",
      displayName: "Asha",
      webinarInviteCode: "webinar-code",
      meetingInviteCode: "meeting-code",
    };

    // The reconnect asks for a token, which names another identity.
    await expect(h.api.connectSocket("room-a")).rejects.toThrow("another identity");
    // The page has taken that identity and joins again.
    void h.api.joinRoomById("room-a");
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledTimes(1));

    expect(refs.joinOptionsRef.current).toEqual(
      expect.objectContaining({
        joinMode: "webinar_attendee",
        displayName: "Asha",
        webinarInviteCode: "webinar-code",
        meetingInviteCode: "meeting-code",
      }),
    );
  });

  it("does not carry the codes into a join that is not a restart", async () => {
    let refs!: ReturnType<typeof useMeetRefs>;
    const h = createHarness({
      adoptJoinIdentity: () => false,
      joinMode: "webinar_attendee",
      bypassMediaPermissions: true,
      captureRefs: (captured: ReturnType<typeof useMeetRefs>) => {
        refs = captured;
      },
    } as Partial<Options>);
    refs.joinOptionsRef.current = { joinMode: "webinar_attendee", webinarInviteCode: "code-of-another-meeting" };

    void h.api.joinRoomById("room-b");
    await vi.waitFor(() => expect(h.io).toHaveBeenCalledTimes(1));

    expect(refs.joinOptionsRef.current?.webinarInviteCode).toBeUndefined();
  });
});
