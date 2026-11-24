// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorityProvider } from "@conclave/apps-sdk";
import type { AuthoritySocket } from "@conclave/apps-sdk/authority";
import { QaPanel } from "../src/app/components/qa/QaPanel";
import { useReconnectHold } from "../src/app/hooks/useHeldThroughReconnect";
import { useMeetingQa } from "../src/app/hooks/useMeetingQa";
import type { ConnectionState, WebinarQaEntry } from "../src/app/lib/types";

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const socket: AuthoritySocket = {
  connected: true,
  on: (event, listener) => {
    listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
  },
  off: (event, listener) => {
    listeners.get(event)?.delete(listener);
  },
  emit: () => {},
};

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

const submit = vi.fn(async () => ({ ok: true }));
const upvote = vi.fn();
const moderate = vi.fn(async () => ({ ok: true }));

let root: Root;
let container: HTMLDivElement;

function Webinar({
  connectionState,
  entries,
  fromThisConnection,
}: {
  connectionState: ConnectionState;
  entries: WebinarQaEntry[] | null;
  fromThisConnection: boolean;
}) {
  const hold = useReconnectHold({ isJoined: true, connectionState });
  const qa = useMeetingQa({
    legacy: { entries, fromThisConnection, forget: () => {}, submit, upvote, moderate },
    isWebinar: true,
    hold,
    currentUserId: "host#1",
  });
  return (
    <QaPanel
      audience="webinar"
      entries={qa.entries}
      qaEnabled
      currentUserId="host#1"
      onClose={() => {}}
      onSubmit={qa.onSubmit}
      onUpvote={qa.onUpvote}
      onModerate={qa.onModerate}
      waiting={qa.waiting}
      connection={qa.connection}
    />
  );
}

const render = async (
  connectionState: ConnectionState,
  entries: WebinarQaEntry[] | null,
  fromThisConnection: boolean,
  socketOpen = true,
) =>
  act(async () =>
    root.render(
      <AuthorityProvider socket={socketOpen ? socket : null} joined={connectionState === "joined"}>
        <Webinar connectionState={connectionState} entries={entries} fromThisConnection={fromThisConnection} />
      </AuthorityProvider>,
    ),
  );

const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
const moderation = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="qa-entry"] button')).filter(
    (element) => element.dataset.testid !== "qa-upvote",
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  listeners.clear();
  submit.mockClear();
  upvote.mockClear();
  moderate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a webinar's Ask, Enter, Upvote and moderation from sending in the second after a drop, on a server without the runtime", async () => {
  await render("joined", [question], true);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="qa-input"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, "Are the slides public?");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const liveBeforeTheDrop = !button("qa-send").disabled && !button("qa-upvote").disabled;

  await act(async () => {
    for (const listener of [...(listeners.get("disconnect") ?? [])]) listener();
  });
  await render("reconnecting", [question], false);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (const control of [button("qa-send"), button("qa-upvote"), ...moderation()]) control.click();
  });
  const controls = [button("qa-send"), button("qa-upvote"), ...moderation()];

  expect(liveBeforeTheDrop).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  expect(upvote).not.toHaveBeenCalled();
  expect(moderate).not.toHaveBeenCalled();
  expect(controls.length).toBeGreaterThan(2);
  expect(controls.every((control) => control.disabled)).toBe(true);
  expect(input.value).toBe("Are the slides public?");
});

it("frees a webinar's Ask the moment a new connection's list is in, while the old connection's question is still out, on a server without the runtime", async () => {
  let settle!: (value: { ok: boolean; error?: string }) => void;
  submit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await render("joined", [question], true);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="qa-input"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  const typeQuestion = async (text: string) =>
    act(async () => {
      setValue?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await typeQuestion("Asked on the old connection");
  await act(async () => button("qa-send").click());
  const heldWhileOut = button("qa-send").disabled;

  await act(async () => {
    for (const listener of [...(listeners.get("disconnect") ?? [])]) listener();
  });
  await render("reconnecting", [question], false);
  await render("joined", [question], true);
  await typeQuestion("A new draft");
  const freeOnTheNewConnection = !button("qa-send").disabled;
  await act(async () => settle({ ok: false, error: "The server did not respond. Try again." }));

  expect(heldWhileOut).toBe(true);
  expect(freeOnTheNewConnection).toBe(true);
  expect(input.value).toBe("A new draft");
  expect(container.textContent).not.toContain("did not respond");
});
