// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import { AUTHORITY_EVENTS, type AuthoritySocket } from "@conclave/apps-sdk/authority";
import { usePolls, type PollsApp } from "@conclave/apps-sdk/polls/web";

type Listener = (...args: unknown[]) => void;
type Sent = { event: string; payload: Record<string, unknown>; ack?: (reply: unknown) => void };

const listeners = new Map<string, Set<Listener>>();
const sent: Sent[] = [];
const socket: AuthoritySocket = {
  connected: true,
  on: (event, listener) => {
    listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
  },
  off: (event, listener) => {
    listeners.get(event)?.delete(listener);
  },
  emit: (event, payload, ack) => {
    sent.push({ event, payload: (payload ?? {}) as Record<string, unknown>, ack: ack as Sent["ack"] });
  },
};
const last = (event: string) => [...sent].reverse().find((entry) => entry.event === event)!;
const push = (payload: unknown) => {
  for (const listener of [...(listeners.get(AUTHORITY_EVENTS.frame) ?? [])]) listener(payload);
};

let root: Root;
let polls: PollsApp;
const started: string[] = [];

function Probe() {
  polls = usePolls({ onPollStarted: (poll) => started.push(poll.id) });
  return null;
}

const card = (id: string, status: "open" | "ended" = "open") => ({
  bucket: "polls",
  key: id,
  value: {
    id,
    question: `Question ${id}`,
    choiceMode: "single",
    options: [
      { id: "o1", text: "Yes" },
      { id: "o2", text: "No" },
    ],
    status,
    resultsShared: false,
    createdAt: Number(id.slice(1)),
    endedAt: null,
    createdByName: "Hana",
  },
});

/** Plays a server that offers polls and sends the first view. */
const serve = async (rows: unknown[], grants = { actions: ["vote"], needsIdentity: [], queries: [] }) => {
  await act(async () =>
    last(AUTHORITY_EVENTS.capabilities).ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch: "epoch",
        serverNowMs: Date.now(),
        apps: [{ instance: "polls.1", app: "polls", major: 1, surface: "panel" }],
      },
    }),
  );
  const subscription = last(AUTHORITY_EVENTS.subscribe).payload.subscription as string;
  await act(async () =>
    push({ kind: "replace", subscription, generation: 1, serverNowMs: Date.now(), part: 0, last: true, rows, grants }),
  );
  return subscription;
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  listeners.clear();
  sent.length = 0;
  started.length = 0;
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <AuthorityProvider socket={socket} joined>
        <Probe />
      </AuthorityProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows a late joiner the polls already running, with their own vote and no results", async () => {
  await serve([card("p1"), { bucket: "myVotes", key: "p1", value: { optionIds: ["o2"] } }]);

  expect(polls.polls).toMatchObject([{ id: "p1", myVote: ["o2"], results: null, voterCount: null }]);
  expect(started).toEqual([]);
});

it("has results exactly when the server sends them", async () => {
  const subscription = await serve([card("p1")]);
  expect(polls.polls[0].results).toBeNull();

  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [{ bucket: "results", key: "p1", value: { voterCount: 4, votes: { o1: 3, o2: 1 } } }],
      remove: [],
    }),
  );
  const shared = polls.polls[0];
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 2,
      put: [],
      remove: [{ bucket: "results", key: "p1" }],
    }),
  );

  expect(shared.voterCount).toBe(4);
  expect(shared.results?.map((row) => row.percent)).toEqual([75, 25]);
  expect(polls.polls[0].results).toBeNull();
});

it("announces a poll that opens after the first look, and only an open one", async () => {
  const subscription = await serve([card("p1")]);

  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [card("p2"), card("p3", "ended")],
      remove: [],
    }),
  );

  expect(started).toEqual(["p2"]);
});

it("reports the server's reason when a vote is refused", async () => {
  await serve([card("p1")]);

  let result: unknown;
  await act(async () => {
    void polls.vote("p1", ["o1"]).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    last(AUTHORITY_EVENTS.act).ack!({ ok: false, code: "rejected", reason: "already-voted" });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(last(AUTHORITY_EVENTS.act).payload).toMatchObject({
    action: "vote",
    input: { pollId: "p1", optionIds: ["o1"] },
  });
  expect(result).toEqual({ ok: false, error: "You already voted" });
});

it("tells a viewer who needs to sign in, and offers them no vote", async () => {
  await serve([card("p1")], { actions: [], needsIdentity: ["vote"], queries: [] });

  expect([polls.canVote, polls.voteNeedsIdentity, polls.canManage]).toEqual([false, true, false]);
});

it("forgets every poll when the server withdraws the view", async () => {
  const subscription = await serve([card("p1")]);

  await act(async () =>
    push({ kind: "revoke", subscription, generation: 1, serverNowMs: Date.now(), reason: "closed" }),
  );

  expect(polls.polls).toEqual([]);
  expect(polls.isReady).toBe(false);
});
