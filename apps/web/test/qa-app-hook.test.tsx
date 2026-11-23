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

it("shows what the view says when a lost answer's retry comes back after another tab took the upvote away", async () => {
  const myUpvote = (seq: number, voted: boolean) =>
    act(async () =>
      push({
        kind: "patch",
        subscription,
        generation: 1,
        serverNowMs: Date.now(),
        seq,
        put: voted ? [{ bucket: "myUpvotes", key: "q1", value: {} }] : [],
        remove: voted ? [] : [{ bucket: "myUpvotes", key: "q1" }],
      }),
    );
  const { outcome } = await click();
  const shownWhileSending = qa.questions[0].hasUpvoted;
  // The first answer is lost on the way back. The upvote landed, and its row
  // arrives. Then the same person takes the upvote back in another tab.
  await myUpvote(1, true);
  await myUpvote(2, false);
  const shownAfterTheOtherTab = qa.questions[0].hasUpvoted;
  // No answer came, so the same operation is sent again, and the server
  // answers it with the result it kept for that operation.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  const requests = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.act);
  await act(async () => {
    requests[1]?.ack?.({ ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(shownWhileSending).toBe(true);
  expect(shownAfterTheOtherTab).toBe(false);
  expect(requests.length).toBe(2);
  expect(requests[1].payload.operation).toEqual(requests[0].payload.operation);
  expect(await outcome).toEqual({ ok: true });
  // The view says the upvote is gone, and nothing newer says otherwise.
  expect(qa.questions[0].hasUpvoted).toBe(false);
});

it("sends a click made against the newer view again, when a lost answer's retry comes back for the same value", async () => {
  const myUpvote = (seq: number, voted: boolean) =>
    act(async () =>
      push({
        kind: "patch",
        subscription,
        generation: 1,
        serverNowMs: Date.now(),
        seq,
        put: voted ? [{ bucket: "myUpvotes", key: "q1", value: {} }] : [],
        remove: voted ? [] : [{ bucket: "myUpvotes", key: "q1" }],
      }),
    );
  await click();
  await myUpvote(1, true);
  await myUpvote(2, false);
  // The button shows the upvote gone, so the viewer clicks to upvote again
  // while the first request is still waiting for its answer.
  await click();
  const shownAfterTheClick = qa.questions[0].hasUpvoted;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  const retried = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.act);
  await act(async () => {
    retried[1]?.ack?.({ ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
  });
  const requests = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.act);
  await act(async () => {
    requests[2]?.ack?.({ ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
  });
  await myUpvote(3, true);

  expect(shownAfterTheClick).toBe(true);
  // The retry, then a new request for the click: the server held no upvote.
  expect(requests.map((entry) => (entry.payload.input as { value: boolean }).value)).toEqual([
    true,
    true,
    true,
  ]);
  expect(requests[2].payload.operation).not.toEqual(requests[0].payload.operation);
  expect(qa.questions[0].hasUpvoted).toBe(true);
});

it("shows what the view says when the person's changes cancelled out and a lost answer's retry comes back", async () => {
  const { outcome } = await click();
  // The first answer is lost. The same person takes the upvote back in
  // another tab before the flush, so their view never changes. The server
  // still tells this tab how far its view has come.
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [],
      remove: [],
      revision: 2,
    }),
  );
  // The retry is answered with the outcome kept for that operation, and
  // the room's revision as it is now.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  const requests = sent.filter((entry) => entry.event === AUTHORITY_EVENTS.act);
  await act(async () => {
    requests[1]?.ack?.({ ok: true, value: null, revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(requests.length).toBe(2);
  expect(await outcome).toEqual({ ok: true });
  // The view is at the answer's revision and says there is no upvote.
  expect(qa.questions[0].hasUpvoted).toBe(false);
});

it("keeps showing an upvote until the view reaches the revision its answer named", async () => {
  await click();
  const request = sent.find((entry) => entry.event === AUTHORITY_EVENTS.act)!;
  await act(async () => {
    request.ack!({ ok: true, value: null, revision: 1 });
    await vi.advanceTimersByTimeAsync(0);
  });
  const shownBeforeTheRow = qa.questions[0].hasUpvoted;
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [{ bucket: "myUpvotes", key: "q1", value: {} }],
      remove: [],
      revision: 1,
    }),
  );

  expect(shownBeforeTheRow).toBe(true);
  expect(qa.questions[0].hasUpvoted).toBe(true);
});


it("keeps a pending upvote when the person's vote on another question changes meanwhile", async () => {
  await click();
  const pending = qa.questions.find((item) => item.id === "q1")?.hasUpvoted;
  // Another tab of theirs upvotes a different question before the answer.
  await act(async () =>
    push({
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [{ bucket: "myUpvotes", key: "q2", value: {} }],
      remove: [],
    }),
  );
  const afterOtherVote = qa.questions.find((item) => item.id === "q1")?.hasUpvoted;
  // A second quick click is a change of mind about q1.
  await click();
  await answer({ ok: true, value: null, revision: 3 }, 2);

  expect(pending).toBe(true);
  expect(afterOtherVote).toBe(true);
  expect(upvotesSent()).toEqual([true, false]);
});

const reconnect = async (rows: unknown[]): Promise<{ upvotesSent: () => boolean[] }> => {
  const next = new Map<string, Set<Listener>>();
  const nextSent: Sent[] = [];
  const nextSocket: AuthoritySocket = {
    connected: true,
    on: (event, listener) => {
      next.set(event, (next.get(event) ?? new Set()).add(listener));
    },
    off: (event, listener) => {
      next.get(event)?.delete(listener);
    },
    emit: (event, payload, ack) => {
      nextSent.push({ event, payload: (payload ?? {}) as Record<string, unknown>, ack: ack as Sent["ack"] });
    },
  };
  await act(async () =>
    root.render(
      <AuthorityProvider socket={nextSocket} joined>
        <Probe />
      </AuthorityProvider>,
    ),
  );
  const nextLast = (event: string) => [...nextSent].reverse().find((entry) => entry.event === event)!;
  await act(async () =>
    nextLast(AUTHORITY_EVENTS.capabilities).ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch: "epoch",
        serverNowMs: Date.now(),
        apps: [{ instance: "qa.1", app: "qa", major: 1, surface: "panel" }],
      },
    }),
  );
  await act(async () => {
    for (const listener of [...(next.get(AUTHORITY_EVENTS.frame) ?? [])]) {
      listener({
        kind: "replace",
        subscription: nextLast(AUTHORITY_EVENTS.subscribe).payload.subscription,
        generation: 1,
        serverNowMs: Date.now(),
        part: 0,
        last: true,
        revision: 1,
        rows,
        grants: { actions: ["upvote"], needsIdentity: [], queries: [] },
      });
    }
  });
  return {
    upvotesSent: () =>
      nextSent
        .filter((entry) => entry.event === AUTHORITY_EVENTS.act)
        .map((entry) => (entry.payload.input as { value: boolean }).value),
  };
};

it("lets a new connection's view decide an upvote answered on the old one", async () => {
  // The upvote is answered, but its row has not come when the socket drops.
  await click();
  await answer({ ok: true, value: null, revision: 2 }, 1, true);
  const shownOnTheOldSocket = qa.questions[0].hasUpvoted;
  // Meanwhile another tab took the vote away.
  const next = await reconnect([question, { bucket: "votes", key: "q1", value: { upvotes: 0 } }]);
  const shownOnTheNewSocket = qa.questions[0].hasUpvoted;
  await act(async () => {
    void qa.toggleUpvote("q1");
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(shownOnTheOldSocket).toBe(true);
  expect(shownOnTheNewSocket).toBe(false);
  expect(next.upvotesSent()).toEqual([true]);
});

it("sends a click made after a reconnect on the new connection, while the old one's request is still out", async () => {
  // The upvote is on its way when the socket drops. It landed: the new
  // connection's view shows it.
  await click();
  const next = await reconnect([
    question,
    { bucket: "votes", key: "q1", value: { upvotes: 1 } },
    { bucket: "myUpvotes", key: "q1", value: {} },
  ]);
  const shownOnTheNewSocket = qa.questions[0].hasUpvoted;
  // The viewer takes the vote back.
  await act(async () => {
    void qa.toggleUpvote("q1");
    await vi.advanceTimersByTimeAsync(0);
  });
  // The old connection's request ends without an answer.
  await act(async () => vi.advanceTimersByTimeAsync(10_000));

  expect(shownOnTheNewSocket).toBe(true);
  expect(next.upvotesSent()[0]).toBe(false);
  expect(qa.questions[0].hasUpvoted).toBe(false);
});

it("drops an upvote the old connection never got through, once its request ends", async () => {
  const { outcome } = await click();
  const viewWithoutTheVote = [question, { bucket: "votes", key: "q1", value: { upvotes: 0 } }];
  const next = await reconnect(viewWithoutTheVote);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  const shownOnceItEnded = qa.questions[0].hasUpvoted;
  const ended = await outcome;
  await act(async () => {
    void qa.toggleUpvote("q1");
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(shownOnceItEnded).toBe(false);
  expect(ended.ok).toBe(false);
  expect(next.upvotesSent()).toEqual([true]);
  expect(qa.questions[0].hasUpvoted).toBe(true);
});
