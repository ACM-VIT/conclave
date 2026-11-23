// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import { AUTHORITY_EVENTS, type AuthoritySocket } from "@conclave/apps-sdk/authority";
import { useMeetingPolls } from "../src/app/hooks/useMeetingPolls";
import { WAITING_FOR_VIEW } from "../src/app/hooks/useHeldThroughReconnect";

type Listener = (...args: unknown[]) => void;
type Sent = { event: string; payload: Record<string, unknown>; ack?: (reply: unknown) => void };
type Shown = { isAvailable: boolean; ids: string[]; canManage: boolean; canVote: boolean };

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
let current: ReturnType<typeof useMeetingPolls>;
const renders: Shown[] = [];
const latest = () => renders[renders.length - 1];

function Probe({ isJoined, isWebinarAttendee }: { isJoined: boolean; isWebinarAttendee: boolean }) {
  const polls = useMeetingPolls({ isJoined, isWebinarAttendee });
  current = polls;
  renders.push({
    isAvailable: polls.isAvailable,
    ids: polls.polls.map((poll) => poll.id),
    canManage: polls.canManage,
    canVote: polls.canVote,
  });
  return null;
}

const mount = async ({
  connected = true,
  isJoined = true,
  isWebinarAttendee = false,
}: { connected?: boolean; isJoined?: boolean; isWebinarAttendee?: boolean } = {}) => {
  await act(async () =>
    root.render(
      <AuthorityProvider socket={connected ? socket : null} joined={connected}>
        <Probe isJoined={isJoined} isWebinarAttendee={isWebinarAttendee} />
      </AuthorityProvider>,
    ),
  );
};

const card = {
  bucket: "polls",
  key: "p1",
  value: {
    id: "p1",
    question: "Lunch at noon?",
    choiceMode: "single",
    options: [
      { id: "o1", text: "Yes" },
      { id: "o2", text: "No" },
    ],
    status: "open",
    resultsShared: false,
    createdAt: 1,
    endedAt: null,
    createdByName: "Hana",
  },
};
const hostGrants = { actions: ["create", "vote", "end", "share"], needsIdentity: [], queries: ["exportBallots"] };

const offer = async (apps = [{ instance: "polls.1", app: "polls", major: 1, surface: "panel" }]) => {
  await act(async () =>
    last(AUTHORITY_EVENTS.capabilities).ack!({
      ok: true,
      value: { protocol: 1, roomEpoch: "epoch", serverNowMs: Date.now(), apps },
    }),
  );
};

const sendView = async (frame: { generation?: number; last?: boolean; rows?: unknown[] } = {}) => {
  const subscription = last(AUTHORITY_EVENTS.subscribe).payload.subscription as string;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: frame.generation ?? 1,
      serverNowMs: Date.now(),
      part: 0,
      last: frame.last ?? true,
      rows: frame.rows ?? [card],
      grants: hostGrants,
    }),
  );
};

const hostWithAPoll = { isAvailable: true, ids: ["p1"], canManage: true, canVote: true };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  listeners.clear();
  sent.length = 0;
  renders.length = 0;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a host's polls panel, its polls and its composer while the connection comes back, at every render", async () => {
  await mount();
  await offer();
  await sendView();
  const beforeTheDrop = latest();
  const fromTheDrop = renders.length;

  await mount({ connected: false });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await mount();
  await offer();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  await sendView();

  expect(beforeTheDrop).toEqual(hostWithAPoll);
  expect(renders.slice(fromTheDrop).every((shown) => JSON.stringify(shown) === JSON.stringify(hostWithAPoll))).toBe(true);
  expect(renders.length).toBeGreaterThan(fromTheDrop);
});

it("lets polls go when the server answers without them after a reconnect", async () => {
  await mount();
  await offer();
  await sendView();

  await mount({ connected: false });
  await mount();
  await offer([]);

  expect(latest()).toEqual({ isAvailable: false, ids: [], canManage: false, canVote: false });
});

it("lets polls go when the person leaves the meeting while the connection is down", async () => {
  await mount();
  await offer();
  await sendView();

  await mount({ connected: false, isJoined: false });

  expect(latest()).toEqual({ isAvailable: false, ids: [], canManage: false, canVote: false });
});

it("lets polls go when the person becomes a webinar attendee while the connection is down", async () => {
  await mount();
  await offer();
  await sendView();

  await mount({ connected: false, isWebinarAttendee: true });

  expect(latest().isAvailable).toBe(false);
});

it("shows no polls while a new view comes in parts, and keeps the host's composer", async () => {
  await mount();
  await offer();
  await sendView();
  const fromTheReplacement = renders.length;

  await sendView({ generation: 2, last: false, rows: [] });
  const whileReplacing = renders.slice(fromTheReplacement);

  expect(whileReplacing.length).toBeGreaterThan(0);
  expect(whileReplacing.every((shown) => shown.ids.length === 0 && shown.canManage && shown.isAvailable)).toBe(true);
});

it("forgets the polls and the composer when the server withdraws the view", async () => {
  await mount();
  await offer();
  await sendView();
  const subscription = last(AUTHORITY_EVENTS.subscribe).payload.subscription as string;

  await act(async () =>
    push({ kind: "revoke", subscription, generation: 1, serverNowMs: Date.now(), reason: "forbidden" }),
  );

  expect(latest()).toMatchObject({ ids: [], canManage: false, canVote: false });
});

it("keeps every poll action waiting while the view comes back, and sends nothing for them", async () => {
  await mount();
  await offer();
  await sendView();
  await mount({ connected: false });
  await mount();
  await offer();
  const whileWaiting = current;
  const fromTheGap = sent.length;
  const answers: Promise<{ ok: boolean; error?: string }>[] = [];
  await act(async () => {
    answers.push(whileWaiting.createPoll({ question: "Lunch?", options: ["Yes", "No"], choiceMode: "single" }));
    answers.push(whileWaiting.vote("p1", ["o1"]));
    answers.push(whileWaiting.endPoll("p1"));
    answers.push(whileWaiting.shareResults("p1", true));
    answers.push(whileWaiting.exportCsv("p1"));
    await vi.advanceTimersByTimeAsync(0);
  });
  await sendView();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  const sentInTheGap = sent
    .slice(fromTheGap)
    .filter((entry) => entry.event === AUTHORITY_EVENTS.act || entry.event === AUTHORITY_EVENTS.query);

  expect(sentInTheGap).toEqual([]);
  expect(whileWaiting.waiting).toBe(true);
  expect(current.waiting).toBe(false);
  const results = await Promise.all(answers);
  expect(results).toEqual([WAITING_FOR_VIEW, WAITING_FOR_VIEW, WAITING_FOR_VIEW, WAITING_FOR_VIEW, WAITING_FOR_VIEW]);
});
