// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import { AUTHORITY_EVENTS, type AuthoritySocket } from "@conclave/apps-sdk/authority";
import { useMeetingQa } from "../src/app/hooks/useMeetingQa";
import type { WebinarQaEntry } from "../src/app/lib/types";

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
const legacy = {
  entries: [fromOldEvents],
  submit: vi.fn(async () => ({ ok: true })),
  upvote: vi.fn(),
  moderate: vi.fn(async () => ({ ok: true })),
};

let root: Root;
let qa: ReturnType<typeof useMeetingQa>;

function Probe({ isWebinar, legacyQa }: { isWebinar: boolean; legacyQa: typeof legacy }) {
  qa = useMeetingQa({ legacy: legacyQa, isWebinar, currentUserId: "me" });
  return null;
}

const mount = async (isWebinar: boolean, legacyQa: typeof legacy = legacy) => {
  await act(async () =>
    root.render(
      <AuthorityProvider socket={socket} joined>
        <Probe isWebinar={isWebinar} legacyQa={legacyQa} />
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
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

