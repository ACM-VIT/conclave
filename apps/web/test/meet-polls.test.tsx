// @vitest-environment happy-dom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { useMeetPolls } from "../src/app/hooks/useMeetPolls";
import type { PollView } from "../src/app/lib/types";

type Ack = (error: Error | null, response?: unknown) => void;

let root: Root;
let hook: ReturnType<typeof useMeetPolls>;
let pending: { event: string; payload: unknown[]; ack: Ack }[];
let listeners: Map<string, (payload: unknown) => void>;
let started: PollView[];
let setLink: Dispatch<SetStateAction<{ isInMeeting: boolean; isConnected: boolean }>>;

const socket = {
  on: (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
  },
  off: (event: string) => {
    listeners.delete(event);
  },
  timeout: () => ({
    emit: (event: string, ...rest: unknown[]) => {
      pending.push({
        event,
        payload: rest.slice(0, -1),
        ack: rest[rest.length - 1] as Ack,
      });
    },
  }),
} as unknown as Socket;

const poll = (overrides: Partial<PollView> = {}): PollView => ({
  id: "p1",
  question: "Ship it?",
  choiceMode: "single",
  status: "open",
  resultsShared: false,
  options: [
    { id: "o1", text: "Yes" },
    { id: "o2", text: "No" },
  ],
  createdAt: 1,
  createdByName: "Hana",
  ...overrides,
});

const answer = async (event: string, response: unknown) => {
  const index = pending.findIndex((request) => request.event === event);
  const [request] = pending.splice(index, 1);
  await act(async () => request.ack(null, response));
};

const broadcast = async (payload: unknown) => {
  await act(async () => listeners.get("poll:changed")?.(payload));
};

function Harness() {
  const [link, setLinkState] = useState({ isInMeeting: true, isConnected: true });
  setLink = setLinkState;
  hook = useMeetPolls({
    socket,
    ...link,
    onPollStarted: (value) => started.push(value),
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pending = [];
  listeners = new Map();
  started = [];
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a late joiner the polls already running, with their own vote", async () => {
  expect(hook.isSupported).toBe(false);
  await answer("poll:getState", {
    roomId: "room",
    polls: [poll({ myVote: ["o2"] })],
  });

  expect(hook.isSupported).toBe(true);
  expect(hook.polls).toEqual([poll({ myVote: ["o2"] })]);
  expect(started).toEqual([]);
});

it("stays hidden on a server that does not answer the poll snapshot", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await act(async () => pending[0].ack(new Error("operation has timed out")));
  expect(hook.isSupported).toBe(false);
});

it("applies live updates and keeps the viewer's vote", async () => {
  await answer("poll:getState", { roomId: "room", polls: [] });
  await broadcast({ roomId: "room", poll: poll() });
  expect(started.map((value) => value.id)).toEqual(["p1"]);

  let result: Awaited<ReturnType<typeof hook.vote>> | undefined;
  await act(async () => {
    void hook.vote("p1", ["o1"]).then((value) => {
      result = value;
    });
  });
  expect(pending[0]).toMatchObject({
    event: "poll:vote",
    payload: [{ pollId: "p1", optionIds: ["o1"] }],
  });
  await answer("poll:vote", { success: true, poll: poll({ myVote: ["o1"] }) });
  expect(result).toEqual({ ok: true });

  await broadcast({
    roomId: "room",
    poll: poll({ status: "ended", resultsShared: true, voterCount: 1 }),
  });
  expect(hook.polls[0]).toMatchObject({ status: "ended", myVote: ["o1"] });
  expect(started).toHaveLength(1);
});

it("reports the server's reason when a vote is refused", async () => {
  await answer("poll:getState", { roomId: "room", polls: [poll()] });
  let result: Awaited<ReturnType<typeof hook.vote>> | undefined;
  await act(async () => {
    void hook.vote("p1", ["o2"]).then((value) => {
      result = value;
    });
  });
  await answer("poll:vote", {
    error: "You already voted",
    poll: poll({ myVote: ["o1"] }),
  });

  expect(result).toEqual({ ok: false, error: "You already voted" });
  expect(hook.polls[0].myVote).toEqual(["o1"]);
});

it("keeps polls through a reconnect and resyncs when it rejoins", async () => {
  await answer("poll:getState", { roomId: "room", polls: [poll({ myVote: ["o1"] })] });

  await act(async () => setLink({ isInMeeting: true, isConnected: false }));
  expect(hook.polls).toHaveLength(1);
  expect(hook.isSupported).toBe(true);

  await act(async () => setLink({ isInMeeting: true, isConnected: true }));
  await answer("poll:getState", {
    roomId: "room",
    polls: [poll({ myVote: ["o1"], status: "ended" })],
  });
  expect(hook.polls[0].status).toBe("ended");
});

it("forgets every poll when the meeting is left", async () => {
  await answer("poll:getState", { roomId: "room", polls: [poll()] });
  await act(async () => setLink({ isInMeeting: false, isConnected: false }));
  expect(hook.polls).toEqual([]);
  expect(hook.isSupported).toBe(false);
});

it("ignores updates from a room it is not synced to", async () => {
  await answer("poll:getState", { roomId: "room", polls: [] });
  await broadcast({ roomId: "other-room", poll: poll({ id: "p9" }) });
  expect(hook.polls).toEqual([]);
  expect(started).toEqual([]);
});
