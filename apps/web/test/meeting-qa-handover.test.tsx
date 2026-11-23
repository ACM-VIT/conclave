// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import { AUTHORITY_EVENTS, type AuthoritySocket } from "@conclave/apps-sdk/authority";
import { useMeetingQa } from "../src/app/hooks/useMeetingQa";
import type { WebinarQaChangedNotification, WebinarQaEntry } from "../src/app/lib/types";
import { withQaChange, type WebinarQaList } from "../src/app/lib/webinarQaList";

type Listener = (...args: unknown[]) => void;
type LegacyQaProps = Parameters<typeof useMeetingQa>[0]["legacy"];
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
const last = (event: string) => [...sent].reverse().find((entry) => entry.event === event);
const push = (payload: unknown) => {
  for (const listener of [...(listeners.get(AUTHORITY_EVENTS.frame) ?? [])]) listener(payload);
};

/** A question as the old events told it to this client. */
const fromOldEvents: WebinarQaEntry = {
  id: "q1",
  userId: "",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "answering",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 3,
  hasUpvoted: false,
};
const legacy: Omit<LegacyQaProps, "entries"> & { entries: WebinarQaList } = {
  entries: [fromOldEvents],
  submit: vi.fn(async () => ({ ok: true })),
  upvote: vi.fn(),
  moderate: vi.fn(async () => ({ ok: true })),
};

let root: Root;
let qa: ReturnType<typeof useMeetingQa>;
/** The ids each render of the hook showed, in order. */
const renders: string[][] = [];
const offers: { offered: boolean; ids: string[]; asks: "app" | "old events" | "nothing" }[] = [];

/** What the socket was sent on the old events, as `useMeetSocket` keeps it. */
let oldEvents: { change: (notification: WebinarQaChangedNotification) => void };

/**
 * The hook over a list as the socket holds it. A new `entries` is a whole
 * list the socket was sent, a change goes through the socket's own rule,
 * and a list the hook is done with is forgotten.
 */
function Probe({
  isWebinar,
  isJoined,
  legacyQa,
}: {
  isWebinar: boolean;
  isJoined: boolean;
  legacyQa: typeof legacy;
}) {
  const [list, setList] = useState<WebinarQaList>(legacyQa.entries);
  const [sent, setSent] = useState<WebinarQaList>(legacyQa.entries);
  if (legacyQa.entries !== sent) {
    setSent(legacyQa.entries);
    setList(legacyQa.entries);
  }
  oldEvents = { change: (notification) => setList((held) => withQaChange(held, notification)) };
  qa = useMeetingQa({
    legacy: { ...legacyQa, entries: list, forget: () => setList(null) },
    isWebinar,
    isJoined,
    currentUserId: "me",
  });
  renders.push(qa.entries.map((entry) => entry.id));
  offers.push({
    offered: qa.offered,
    ids: qa.entries.map((entry) => entry.id),
    asks: !qa.onSubmit ? "nothing" : qa.onSubmit === legacyQa.submit ? "old events" : "app",
  });
  return null;
}

const mount = async (
  isWebinar: boolean,
  legacyQa: typeof legacy = legacy,
  { connected = true, isJoined = true }: { connected?: boolean; isJoined?: boolean } = {},
) => {
  await act(async () =>
    root.render(
      <AuthorityProvider socket={connected ? socket : null} joined={connected}>
        <Probe isWebinar={isWebinar} isJoined={isJoined} legacyQa={legacyQa} />
      </AuthorityProvider>,
    ),
  );
};

/** The server says it runs Q&A. The client asks for the view at once. */
const offerQa = async () => {
  await act(async () =>
    last(AUTHORITY_EVENTS.capabilities)!.ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch: "epoch",
        serverNowMs: Date.now(),
        apps: [{ instance: "qa.1", app: "qa", major: 1, surface: "panel" }],
      },
    }),
  );
};

/** The view arrives, with the same question answered meanwhile. */
const sendView = async () => {
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: [
        {
          bucket: "questions",
          key: "q1",
          value: {
            id: "q1",
            askerName: "Gia",
            text: "Is this recorded?",
            status: "answered",
            askedAt: 1,
            updatedAt: 2,
            answerText: "Yes",
            answeredByName: "Asha",
          },
        },
        { bucket: "votes", key: "q1", value: { upvotes: 4 } },
      ],
      grants: { actions: ["ask", "upvote"], needsIdentity: [], queries: [] },
    }),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  listeners.clear();
  sent.length = 0;
  renders.length = 0;
  offers.length = 0;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fire = async (event: string) =>
  act(async () => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  });

const pendingQuestion = (id: string, text: string) => ({
  bucket: "questions",
  key: id,
  value: { id, askerName: "Gia", text, status: "pending", askedAt: 1, updatedAt: 1, answerText: null, answeredByName: null },
});

/** Two public questions in the app's view, then the host hides the second. */
const hideAfterTheHandover = async () => {
  const offTopic: WebinarQaEntry = {
    ...fromOldEvents,
    id: "q2",
    question: "Off-topic: who is getting lunch?",
    status: "pending",
  };
  // The old events showed both questions before the app's view came.
  await mount(true, { ...legacy, entries: [fromOldEvents, offTopic] });
  await offerQa();
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: [pendingQuestion("q1", "Is this recorded?"), pendingQuestion("q2", "Off-topic: who is getting lunch?")],
      grants: { actions: ["ask", "upvote"], needsIdentity: [], queries: [] },
    }),
  );
  const atHandover = qa.entries.map((entry) => entry.id);
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [],
      remove: [{ bucket: "questions", key: "q2" }],
    }),
  );
  const afterTheHide = qa.entries.map((entry) => entry.id);
  return { subscription, atHandover, afterTheHide, fromTheHide: renders.length };
};

it("keeps a webinar on the old events until its own view of Q&A has arrived", async () => {
  await mount(true);
  const beforeTheAnswer = qa;

  // The server offers Q&A and the client subscribes. The view is slow to come.
  await offerQa();
  const subscribed = last(AUTHORITY_EVENTS.subscribe) !== undefined;
  const whileWaiting = qa;
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  const stillWaiting = qa;

  await sendView();

  expect(beforeTheAnswer).toMatchObject({ offered: false, fromApp: false, entries: [fromOldEvents] });
  expect(subscribed).toBe(true);
  // The old events are all it has until then, and the server keeps sending them.
  expect(whileWaiting).toMatchObject({ offered: true, fromApp: false, entries: [fromOldEvents] });
  expect(whileWaiting.onSubmit).toBe(legacy.submit);
  expect(whileWaiting.onUpvote).toBe(legacy.upvote);
  expect(stillWaiting).toMatchObject({ fromApp: false, entries: [fromOldEvents] });
  // Once the view is in, the app is the source.
  expect(qa.fromApp).toBe(true);
  expect(qa.entries).toMatchObject([{ id: "q1", status: "answered", upvotes: 4, answerText: "Yes" }]);
  expect(qa.onSubmit).not.toBe(legacy.submit);
});

it("stays on the old events when the server's answer comes too late to use", async () => {
  await mount(true);
  // Longer than the wait for an answer.
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  const gaveUp = qa;
  await offerQa();

  expect(gaveUp).toMatchObject({ offered: false, fromApp: false, entries: [fromOldEvents] });
  expect(qa).toMatchObject({ offered: false, fromApp: false, entries: [fromOldEvents] });
  expect(last(AUTHORITY_EVENTS.subscribe)).toBeUndefined();
});

it("offers meeting Q&A as soon as the server does, with nothing borrowed from the old events", async () => {
  await mount(false);
  await offerQa();
  const whileWaiting = qa;
  await sendView();

  // The old events carry webinar Q&A only: nothing of theirs is shown or sent.
  expect(whileWaiting).toMatchObject({ offered: true, fromApp: false, entries: [] });
  expect(whileWaiting.onSubmit).toBeUndefined();
  expect(whileWaiting.onUpvote).toBeUndefined();
  expect(qa).toMatchObject({ offered: true, fromApp: true });
  expect(qa.entries.length).toBe(1);
});

it("never falls back to the old events once the app's view has arrived, even while a new view comes in parts", async () => {
  // The old events stop once the app's view is in, so this list is as it
  // was at the handover, with a question the host hides afterwards.
  const offTopic: WebinarQaEntry = {
    ...fromOldEvents,
    id: "q2",
    question: "Off-topic: who is getting lunch?",
    status: "pending",
  };
  await mount(true, { ...legacy, entries: [fromOldEvents, offTopic] });
  await offerQa();
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;
  const question = (id: string, text: string) => ({
    bucket: "questions",
    key: id,
    value: { id, askerName: "Gia", text, status: "pending", askedAt: 1, updatedAt: 1, answerText: null, answeredByName: null },
  });
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: [question("q1", "Is this recorded?"), question("q2", "Off-topic: who is getting lunch?")],
      grants: { actions: ["ask", "upvote"], needsIdentity: [], queries: [] },
    }),
  );
  const atHandover = qa.entries.map((entry) => entry.id);
  // The host hides the second question.
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [],
      remove: [{ bucket: "questions", key: "q2" }],
    }),
  );
  const afterTheHide = qa.entries.map((entry) => entry.id);
  // Then a new view comes in two parts.
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 2,
      serverNowMs: Date.now(),
      part: 0,
      last: false,
      rows: [question("q1", "Is this recorded?")],
      grants: { actions: ["ask", "upvote"], needsIdentity: [], queries: [] },
    }),
  );
  const betweenTheParts = qa;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 2,
      serverNowMs: Date.now(),
      part: 1,
      last: true,
      rows: [],
    }),
  );

  expect(atHandover).toEqual(["q1", "q2"]);
  expect(afterTheHide).toEqual(["q1"]);
  // Between the parts nothing stale is shown, and nothing goes out on the old events.
  expect(betweenTheParts.entries.map((entry) => entry.id)).not.toContain("q2");
  expect(betweenTheParts.onSubmit).not.toBe(legacy.submit);
  expect(betweenTheParts.onUpvote).not.toBe(legacy.upvote);
  expect(qa.fromApp).toBe(true);
  expect(qa.entries.map((entry) => entry.id)).toEqual(["q1"]);
});

it("goes back to the old events on a new connection, and stays on them while its view does not come", async () => {
  const offTopic: WebinarQaEntry = {
    ...fromOldEvents,
    id: "q2",
    question: "Off-topic: who is getting lunch?",
    status: "pending",
  };
  await mount(true, { ...legacy, entries: [fromOldEvents, offTopic] });
  await offerQa();
  await sendView();
  const handedOver = qa.fromApp;

  // The connection drops and comes back. On the new connection the server
  // feeds the old events again, from a list as it is now.
  await fire("disconnect");
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  await fire("connect");
  await offerQa();
  const subscribedAgain = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.subscribe).length;
  // The new subscription is never answered and no view comes.
  await act(async () => vi.advanceTimersByTimeAsync(8_000));

  expect(handedOver).toBe(true);
  expect(subscribedAgain).toBe(2);
  expect(qa).toMatchObject({ offered: true, fromApp: false });
  expect(qa.entries.map((entry) => entry.id)).toEqual(["q1"]);
  expect(qa.onSubmit).toBe(legacy.submit);
  expect(qa.onUpvote).toBe(legacy.upvote);
});

it("goes back to the old events when the connection drops while a new view is coming in parts", async () => {
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  await offerQa();
  await sendView();
  // A new view starts to come in parts.
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 2,
      serverNowMs: Date.now(),
      part: 0,
      last: false,
      rows: [],
      grants: { actions: ["ask", "upvote"], needsIdentity: [], queries: [] },
    }),
  );
  const whileReplacing = qa;
  // The connection drops before the last part, and comes back. The old
  // events give the new connection its own list.
  await fire("disconnect");
  await fire("connect");
  await offerQa();
  const beforeItsList = qa;
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  const afterOneReconnect = qa;
  // It drops and comes back again before any view arrives.
  await fire("disconnect");
  await mount(true, { ...legacy, entries: null });
  await fire("connect");
  await offerQa();
  const beforeTheNextList = qa;
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  await act(async () => vi.advanceTimersByTimeAsync(8_000));

  expect(whileReplacing).toMatchObject({ fromApp: false, entries: [] });
  // Until the new connection has a list, what was shown stays.
  expect(beforeItsList.entries).toEqual([]);
  expect(beforeTheNextList.entries.map((entry) => entry.id)).toEqual(["q1"]);
  // A new connection is a new subscription: the old events again.
  expect(afterOneReconnect).toMatchObject({ offered: true, fromApp: false });
  expect(afterOneReconnect.entries.map((entry) => entry.id)).toEqual(["q1"]);
  expect(afterOneReconnect.onSubmit).toBe(legacy.submit);
  expect(qa).toMatchObject({ offered: true, fromApp: false });
  expect(qa.entries.map((entry) => entry.id)).toEqual(["q1"]);
  expect(qa.onUpvote).toBe(legacy.upvote);
});


it("never shows a question the host hid again while the connection comes back, at any render", async () => {
  const { atHandover, afterTheHide, fromTheHide } = await hideAfterTheHandover();

  // The attendee's socket drops and comes back. The new connection's first
  // list is slow to come, as it was in the browser.
  await fire("disconnect");
  await fire("connect");
  await offerQa();
  await act(async () => vi.advanceTimersByTimeAsync(1_270));
  const whileWaiting = qa;
  // The old events give the new connection its list, as it is now.
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  const onTheNewList = qa.entries.map((entry) => entry.id);
  // Then the new connection's view of the app comes.
  await sendView();

  expect(atHandover).toEqual(["q1", "q2"]);
  expect(afterTheHide).toEqual(["q1"]);
  for (const shown of renders.slice(fromTheHide)) expect(shown).not.toContain("q2");
  // Until the new connection sends anything, the list last shown stays.
  expect(whileWaiting).toMatchObject({ offered: true, fromApp: false });
  expect(whileWaiting.entries.map((entry) => entry.id)).toEqual(["q1"]);
  expect(renders.slice(fromTheHide).every((shown) => shown.join() === "q1")).toBe(true);
  expect(onTheNewList).toEqual(["q1"]);
  expect(qa.fromApp).toBe(true);
});

it("never shows a question the host hid again while the same connection subscribes again, at any render", async () => {
  const { subscription, atHandover, afterTheHide, fromTheHide } = await hideAfterTheHandover();
  const subscribed = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.subscribe).length;

  // A patch goes missing, so the client starts over on the same connection.
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 3,
      put: [],
      remove: [],
    }),
  );
  const subscribedAgain = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.subscribe).length;
  await act(async () => vi.advanceTimersByTimeAsync(1_270));
  const whileWaiting = qa;
  // The old events resume with a whole list, as it is now.
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  const onTheNewList = qa.entries.map((entry) => entry.id);

  expect(atHandover).toEqual(["q1", "q2"]);
  expect(afterTheHide).toEqual(["q1"]);
  expect(subscribedAgain).toBe(subscribed + 1);
  for (const shown of renders.slice(fromTheHide)) expect(shown).not.toContain("q2");
  expect(whileWaiting.entries.map((entry) => entry.id)).toEqual(["q1"]);
  expect(onTheNewList).toEqual(["q1"]);
  expect(qa.onSubmit).toBe(legacy.submit);
});

it("shows a host each question once their meeting becomes a webinar, with no list sent first", async () => {
  // A server without the runtime: the client asks what it offers and is
  // never answered.
  await mount(false, { ...legacy, entries: null });
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  const inTheMeeting = qa;
  // Webinar mode starts. A server that sends no list with it still sends
  // each question as it comes.
  await mount(true, { ...legacy, entries: null });
  const fromTheQuestion = renders.length;
  await act(async () =>
    oldEvents.change({
      roomId: "room",
      entry: { ...fromOldEvents, id: "q9", question: "First question", status: "pending" },
    }),
  );

  expect(inTheMeeting).toMatchObject({ offered: false, fromApp: false, entries: [] });
  expect(qa.entries.map((entry) => entry.id)).toEqual(["q9"]);
  expect(renders.slice(fromTheQuestion).length).toBeGreaterThan(0);
  expect(renders.slice(fromTheQuestion).every((shown) => shown.join() === "q9")).toBe(true);
});

it("clears an attendee's list at once when webinar mode ends and the server withdraws Q&A", async () => {
  await mount(true, { ...legacy, entries: [fromOldEvents] });
  await offerQa();
  await sendView();
  const onTheApp = qa.entries.map((entry) => entry.id);
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;

  // The host turns webinar mode off with Q&A still on, and the server
  // withdraws the attendee's view.
  const fromTheRevoke = renders.length;
  await act(async () =>
    push({ kind: "revoke", subscription, generation: 1, serverNowMs: Date.now(), reason: "forbidden" }),
  );
  const atTheRevoke = qa;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));

  expect(onTheApp).toEqual(["q1"]);
  expect(atTheRevoke.entries).toEqual([]);
  expect(renders.slice(fromTheRevoke).length).toBeGreaterThan(0);
  expect(renders.slice(fromTheRevoke).every((shown) => shown.length === 0)).toBe(true);
  expect(qa.entries).toEqual([]);
});

it("clears a meeting's list at once when the server withdraws Q&A", async () => {
  await mount(false, { ...legacy, entries: null });
  await offerQa();
  await sendView();
  const onTheApp = qa.entries.map((entry) => entry.id);
  const subscription = last(AUTHORITY_EVENTS.subscribe)!.payload.subscription as string;

  const fromTheRevoke = renders.length;
  await act(async () =>
    push({ kind: "revoke", subscription, generation: 1, serverNowMs: Date.now(), reason: "forbidden" }),
  );

  expect(onTheApp).toEqual(["q1"]);
  expect(renders.slice(fromTheRevoke).every((shown) => shown.length === 0)).toBe(true);
  expect(qa.entries).toEqual([]);
});

it("keeps a meeting's Q&A, its list and its composer while the connection comes back, at every render", async () => {
  const noOldList = { ...legacy, entries: null };
  await mount(false, noOldList);
  await offerQa();
  await sendView();
  const beforeTheDrop = offers[offers.length - 1];
  const fromTheDrop = offers.length;

  await mount(false, noOldList, { connected: false });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await mount(false, noOldList);
  await offerQa();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  await sendView();
  const throughTheReconnect = offers.slice(fromTheDrop);

  expect(beforeTheDrop).toEqual({ offered: true, ids: ["q1"], asks: "app" });
  expect(throughTheReconnect.length).toBeGreaterThan(0);
  expect(throughTheReconnect.every((shown) => JSON.stringify(shown) === JSON.stringify(beforeTheDrop))).toBe(true);
});

it("lets a meeting's Q&A go when the server answers without it after a reconnect", async () => {
  const noOldList = { ...legacy, entries: null };
  await mount(false, noOldList);
  await offerQa();
  await sendView();

  await mount(false, noOldList, { connected: false });
  await mount(false, noOldList);
  await act(async () =>
    last(AUTHORITY_EVENTS.capabilities)!.ack!({
      ok: true,
      value: { protocol: 1, roomEpoch: "epoch", serverNowMs: Date.now(), apps: [] },
    }),
  );

  expect(qa.offered).toBe(false);
  expect(qa.entries).toEqual([]);
});

it("lets a meeting's Q&A go when the person leaves the meeting while the connection is down", async () => {
  const noOldList = { ...legacy, entries: null };
  await mount(false, noOldList);
  await offerQa();
  await sendView();

  await mount(false, noOldList, { connected: false, isJoined: false });

  expect(qa.offered).toBe(false);
  expect(qa.entries).toEqual([]);
});
