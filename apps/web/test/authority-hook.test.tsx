// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AuthorityProvider,
  useAuthority,
  useAuthorityAvailable,
  useAuthorityRuntime,
  type AuthorityAppClient,
} from "@conclave/apps-sdk";
import {
  AUTHORITY_EVENTS,
  defineContract,
  s,
  type AuthoritySocket,
} from "@conclave/apps-sdk/authority";

const notesContract = defineContract({
  id: "notes",
  major: 1,
  surface: "panel",
  actions: { add: { input: s.object({ text: s.string({ max: 100 }) }), receipt: s.null() } },
  queries: {},
  views: { notes: s.object({ text: s.string({ max: 100 }) }) },
});

type Listener = (...args: unknown[]) => void;
type Sent = { event: string; payload: Record<string, unknown>; ack?: (reply: unknown) => void };

/** A socket whose server side the test plays by hand. */
const makeSocket = () => {
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
      sent.push({
        event,
        payload: (payload ?? {}) as Record<string, unknown>,
        ack: ack as Sent["ack"],
      });
    },
  };
  return {
    socket,
    sent,
    last: (event: string) => [...sent].reverse().find((entry) => entry.event === event),
    count: (event: string) => sent.filter((entry) => entry.event === event).length,
    push: (event: string, payload: unknown) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
  };
};

let root: Root;
let container: HTMLElement;
let server: ReturnType<typeof makeSocket>;
let app: AuthorityAppClient<typeof notesContract>;

function Notes() {
  app = useAuthority(notesContract);
  const offered = useAuthorityAvailable(notesContract);
  const runtime = useAuthorityRuntime();
  const state = app.state;
  return (
    <div data-kind={state.kind} data-offered={String(offered)} data-runtime={runtime}>
      {state.kind === "ready" &&
        [...state.view.notes.values()].map((note) => <p key={note.text}>{note.text}</p>)}
    </div>
  );
}

const rendered = () => ({
  kind: container.firstElementChild?.getAttribute("data-kind"),
  offered: container.firstElementChild?.getAttribute("data-offered"),
  runtime: container.firstElementChild?.getAttribute("data-runtime"),
  notes: [...container.querySelectorAll("p")].map((node) => node.textContent),
});

const mount = async (children = <Notes />, joined = true) => {
  await act(async () =>
    root.render(
      <AuthorityProvider socket={server.socket} joined={joined}>
        {children}
      </AuthorityProvider>,
    ),
  );
};

/** Plays a server that offers the app and sends its first view. */
const offerAndSubscribe = async (rows: { key: string; text: string }[]) => {
  await act(async () =>
    server.last(AUTHORITY_EVENTS.capabilities)!.ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch: "epoch-1",
        serverNowMs: Date.now(),
        apps: [{ instance: "notes.1", app: "notes", major: 1, surface: "panel" }],
      },
    }),
  );
  const subscribe = server.last(AUTHORITY_EVENTS.subscribe)!;
  const subscription = subscribe.payload.subscription as string;
  await act(async () => {
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "replace",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: rows.map((row) => ({ bucket: "notes", key: row.key, value: { text: row.text } })),
      grants: { actions: ["add"], needsIdentity: [], queries: [] },
    });
    subscribe.ack!({ ok: true, value: null });
  });
  return subscription;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  server = makeSocket();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("hides the app on a server that never answers the capability request", async () => {
  await mount();
  // Not known yet: nothing is said about the server while it may still answer.
  expect(rendered()).toMatchObject({ kind: "connecting", offered: "false", runtime: "unknown" });

  await act(async () => vi.advanceTimersByTimeAsync(6_000));

  expect(rendered()).toMatchObject({ kind: "unsupported", offered: "false", runtime: "unsupported" });
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(0);
});

it("says the server runs apps once it has answered, whichever apps it offers", async () => {
  await mount();
  await act(async () =>
    server.last(AUTHORITY_EVENTS.capabilities)!.ack!({
      ok: true,
      value: { protocol: 1, roomEpoch: "epoch-1", serverNowMs: Date.now(), apps: [] },
    }),
  );

  expect(rendered()).toMatchObject({ offered: "false", runtime: "ready" });
});

it("renders the view the server sends and follows its patches", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "a", text: "first" }]);
  expect(rendered()).toEqual({ kind: "ready", offered: "true", runtime: "ready", notes: ["first"] });

  await act(async () =>
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [{ bucket: "notes", key: "b", value: { text: "second" } }],
      remove: [{ bucket: "notes", key: "a" }],
    }),
  );

  expect(rendered().notes).toEqual(["second"]);
});

it("forgets everything it held when the server revokes the view", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "a", text: "private" }]);

  await act(async () =>
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "revoke",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      reason: "forbidden",
    }),
  );

  expect(rendered()).toMatchObject({ kind: "revoked", notes: [] });
});

it("asks for a fresh view when a patch arrives out of order", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "a", text: "first" }]);

  await act(async () =>
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 3,
      put: [{ bucket: "notes", key: "c", value: { text: "skipped ahead" } }],
      remove: [],
    }),
  );

  expect(rendered().notes).toEqual([]);
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(2);
  expect(server.last(AUTHORITY_EVENTS.subscribe)!.payload.subscription).not.toBe(subscription);
});

it("sends an action on the live view and resolves with the server's answer", async () => {
  await mount();
  const subscription = await offerAndSubscribe([]);

  let result: unknown;
  await act(async () => {
    void app.act("add", { text: "hello" }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
  });
  const sent = server.last(AUTHORITY_EVENTS.act)!;
  await act(async () => {
    sent.ack!({ ok: false, code: "rejected", reason: "too-many" });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(sent.payload).toMatchObject({
    roomEpoch: "epoch-1",
    subscription,
    generation: 1,
    action: "add",
    input: { text: "hello" },
  });
  expect(result).toEqual({ ok: false, code: "rejected", reason: "too-many" });
});

it("shares one subscription between components that use the same app", async () => {
  await mount(
    <>
      <Notes />
      <Notes />
    </>,
  );
  await offerAndSubscribe([{ key: "a", text: "shared" }]);

  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(1);
  expect(container.querySelectorAll("p").length).toBe(2);
});

it("forgets the room's apps when the room is left on a socket that stays open", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "a", text: "from the old room" }]);
  const offer = {
    protocol: 1,
    roomEpoch: "epoch-1",
    serverNowMs: Date.now(),
    apps: [{ instance: "notes.1", app: "notes", major: 1, surface: "panel" }],
  };

  await mount(<Notes />, false);
  const askedBefore = server.count(AUTHORITY_EVENTS.capabilities);
  // The room left behind may still be talking to this socket.
  await act(async () => {
    server.push(AUTHORITY_EVENTS.capabilitiesChanged, offer);
    server.push("connect", undefined);
    await vi.advanceTimersByTimeAsync(20_000);
  });
  const whileAway = rendered();
  const askedWhileAway = server.count(AUTHORITY_EVENTS.capabilities) - askedBefore;

  await mount(<Notes />, true);

  expect(whileAway).toEqual({ kind: "connecting", offered: "false", runtime: "unknown", notes: [] });
  expect(server.last(AUTHORITY_EVENTS.unsubscribe)!.payload).toEqual({ subscription });
  expect(askedWhileAway).toBe(0);
  expect(server.count(AUTHORITY_EVENTS.capabilities)).toBe(askedBefore + 1);
});

it("asks for nothing before the room is joined", async () => {
  await mount(<Notes />, false);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));

  expect(rendered()).toMatchObject({ kind: "connecting", offered: "false" });
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(0);
});
