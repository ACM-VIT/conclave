import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMeetRefs } from "../src/app/hooks/useMeetRefs";
import { useMeetSocket } from "../src/app/hooks/useMeetSocket";
import type { WebinarQaEntry } from "../src/app/lib/types";
import type { WebinarQaList } from "../src/app/lib/webinarQaList";

const joinInfo = { token: "test-token", sfuUrl: "http://localhost:3031" };

const question: WebinarQaEntry = {
  id: "q1",
  userId: "gia#1",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "pending",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 0,
};

const createHarness = () => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    emit: vi.fn(),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  const dispatch = (event: string, ...args: unknown[]) => handlers.get(event)?.(...(args as never[]));
  const io = vi.fn(() => socket);
  let list: WebinarQaList = null;
  const marks: boolean[] = [];
  const setWebinarQaEntries = vi.fn((update: WebinarQaList | ((previous: WebinarQaList) => WebinarQaList)) => {
    list = typeof update === "function" ? update(list) : update;
  });
  const setWebinarQaListFromThisConnection = vi.fn((fromThisConnection: boolean) => {
    marks.push(fromThisConnection);
  });
  let api!: ReturnType<typeof useMeetSocket>;
  let refs!: ReturnType<typeof useMeetRefs>;
  function Harness() {
    refs = useMeetRefs();
    const noop = () => {};
    const supplied = {
      refs,
      roomId: "test-room",
      userId: "host#session",
      localStream: null,
      getJoinInfo: async () => joinInfo,
      prewarm: { io, Device: null, isReady: true },
      isMuted: true,
      isCameraOff: true,
      displayNameInput: "Host",
      primeAudioOutput: () => {},
      chat: { setChatMessages: noop, setChatOverlayMessages: noop, setUnreadCount: noop, isChatOpenRef: { current: false } },
      setWebinarQaEntries,
      setWebinarQaListFromThisConnection,
    };
    const options = new Proxy(supplied, {
      get: (target, key) =>
        key in target
          ? Reflect.get(target, key)
          : typeof key === "string" &&
              (key.startsWith("set") || key === "dispatchParticipants" || key === "clearReactions" || key === "stopLocalTrack")
            ? noop
            : undefined,
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
  return { connect, dispatch, marks, list: () => list, api };
};

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
});
afterEach(() => vi.unstubAllGlobals());

it("marks the old events' list as this connection's when a question change gives it one, with no snapshot", async () => {
  const h = createHarness();
  await h.connect();
  const marksBefore = h.marks.length;

  h.dispatch("webinar:qaChanged", { roomId: "test-room", entry: question });

  expect(h.list()?.map((entry) => entry.id)).toEqual(["q1"]);
  expect(h.marks.slice(marksBefore)).toContain(true);
  expect(h.marks.at(-1)).toBe(true);
  h.api.cleanup();
});

it("marks the old events' list as this connection's when the webinar's settings give it one", async () => {
  const h = createHarness();
  await h.connect();
  const marksBefore = h.marks.length;

  h.dispatch("webinar:configChanged", { enabled: false, publicAccess: false, maxAttendees: 0, attendeeCount: 0, locked: false, requiresInviteCode: false, qaEnabled: true });

  expect(h.list()).toEqual([]);
  expect(h.marks.slice(marksBefore)).toContain(true);
  expect(h.marks.at(-1)).toBe(true);
  h.api.cleanup();
});

it("marks it on a snapshot, and stops counting it the moment the socket disconnects", async () => {
  const h = createHarness();
  await h.connect();

  h.dispatch("webinar:qaSnapshot", { roomId: "test-room", entries: [question] });
  const afterTheSnapshot = h.marks.at(-1);
  h.dispatch("disconnect", "transport close");

  expect(afterTheSnapshot).toBe(true);
  expect(h.marks.at(-1)).toBe(false);
  expect(h.list()).toBeNull();
  h.api.cleanup();
});
