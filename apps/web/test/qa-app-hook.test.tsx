// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import { AUTHORITY_EVENTS, type AuthoritySocket } from "@conclave/apps-sdk/authority";
import { useQa, type QaActionResult, type QaApp } from "@conclave/apps-sdk/qa/web";

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
const upvotesSent = () =>
  sent
    .filter((entry) => entry.event === AUTHORITY_EVENTS.act)
    .map((entry) => (entry.payload.input as { value: boolean }).value);
const push = (payload: unknown) => {
  for (const listener of [...(listeners.get(AUTHORITY_EVENTS.frame) ?? [])]) listener(payload);
};

let root: Root;
let qa: QaApp;
let subscription: string;

function Probe() {
  qa = useQa();
  return null;
}

const question = {
  bucket: "questions",
  key: "q1",
  value: {
    id: "q1",
    askerName: "Gia",
    text: "Is this recorded?",
    status: "pending",
    askedAt: 1,
    updatedAt: 1,
    answerText: null,
    answeredByName: null,
  },
};

/**
 * The server answers the oldest unanswered upvote, then sends the row it
 * changed. `rowLater` holds that row back, as the wire does for a moment.
 */
const answer = async (reply: unknown, seq: number, rowLater = false) => {
  const request = sent.find((entry) => entry.event === AUTHORITY_EVENTS.act && entry.ack)!;
  const acknowledge = request.ack!;
  request.ack = undefined;
  const { value } = request.payload.input as { value: boolean };
  await act(async () => {
    acknowledge(reply);
    await vi.advanceTimersByTimeAsync(0);
  });
  if (!(reply as { ok: boolean }).ok || rowLater) return;
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq,
      put: value ? [{ bucket: "myUpvotes", key: "q1", value: {} }] : [],
      remove: value ? [] : [{ bucket: "myUpvotes", key: "q1" }],
    }),
  );
};

/** One click on the upvote button. `outcome` settles when the server has answered. */
const click = async (): Promise<{ outcome: Promise<QaActionResult> }> => {
  let outcome!: Promise<QaActionResult>;
  await act(async () => {
    outcome = qa.toggleUpvote("q1");
    await vi.advanceTimersByTimeAsync(0);
  });
  return { outcome };
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  listeners.clear();
  sent.length = 0;
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <AuthorityProvider socket={socket} joined>
        <Probe />
      </AuthorityProvider>,
    ),
  );
  await act(async () =>
    last(AUTHORITY_EVENTS.capabilities).ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch: "epoch",
        serverNowMs: Date.now(),
        apps: [{ instance: "qa.1", app: "qa", major: 1, surface: "panel" }],
      },
    }),
  );
  subscription = last(AUTHORITY_EVENTS.subscribe).payload.subscription as string;
  await act(async () =>
    push({
      kind: "replace",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: [question, { bucket: "votes", key: "q1", value: { upvotes: 0 } }],
      grants: { actions: ["upvote"], needsIdentity: [], queries: [] },
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows an upvote at once and settles on what the server sends", async () => {
  await click();
  const shownAtOnce = qa.questions[0].hasUpvoted;
  await answer({ ok: true, value: null }, 1);

  expect(shownAtOnce).toBe(true);
  expect(upvotesSent()).toEqual([true]);
  expect(qa.questions[0].hasUpvoted).toBe(true);
});

it("takes a second click before the answer as a change of mind, sent after the first", async () => {
  await click();
  await click();
  const sentBeforeAnswer = upvotesSent();
  const shownBeforeAnswer = qa.questions[0].hasUpvoted;

  await answer({ ok: true, value: null }, 1);
  const sentAfterFirstAnswer = upvotesSent();
  await answer({ ok: true, value: null }, 2);

  // One request at a time: never two upvotes for one click to add and one to remove.
  expect(sentBeforeAnswer).toEqual([true]);
  expect(shownBeforeAnswer).toBe(false);
  expect(sentAfterFirstAnswer).toEqual([true, false]);
  expect(qa.questions[0].hasUpvoted).toBe(false);
});

it("sends nothing more when a third click returns to what is on its way", async () => {
  await click();
  await click();
  await click();
  await answer({ ok: true, value: null }, 1);

  expect(upvotesSent()).toEqual([true]);
  expect(qa.questions[0].hasUpvoted).toBe(true);
});

it("flips what the server answered when a click lands before the server's row", async () => {
  await click();
  await answer({ ok: true, value: null }, 1, true);
  const shownAfterAnswer = qa.questions[0].hasUpvoted;

  await click();

  expect(shownAfterAnswer).toBe(true);
  expect(upvotesSent()).toEqual([true, false]);
  expect(qa.questions[0].hasUpvoted).toBe(false);
});

it("goes back to the server's state and says why when an upvote is refused", async () => {
  const { outcome } = await click();
  await answer({ ok: false, code: "rate-limited" }, 1);

  expect(await outcome).toEqual({ ok: false, error: "You are voting too quickly" });
  expect(qa.questions[0].hasUpvoted).toBe(false);
});
