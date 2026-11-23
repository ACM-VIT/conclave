// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AuthorityProvider,
  useAuthority,
  useAuthorityAvailable,
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
  const state = app.state;
  return (
    <div data-kind={state.kind} data-offered={String(offered)}>
      {state.kind === "ready" &&
        [...state.view.notes.values()].map((note) => <p key={note.text}>{note.text}</p>)}
    </div>
  );
}

const rendered = () => ({
  kind: container.firstElementChild?.getAttribute("data-kind"),
  offered: container.firstElementChild?.getAttribute("data-offered"),
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
  expect(rendered()).toMatchObject({ kind: "connecting", offered: "false" });

  await act(async () => vi.advanceTimersByTimeAsync(6_000));

  expect(rendered()).toMatchObject({ kind: "unsupported", offered: "false" });
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(0);
});

it("renders the view the server sends and follows its patches", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "a", text: "first" }]);
  expect(rendered()).toEqual({ kind: "ready", offered: "true", notes: ["first"] });

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

it("takes what it may now do from a patch, and keeps the view it holds", async () => {
  await mount();
  const subscription = await offerAndSubscribe([{ key: "n1", text: "first" }]);
  const couldAdd = app.state.kind === "ready" && app.state.actions.has("add");

  // The room's policy changed: the notes are as they were, adding is closed.
  await act(async () =>
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "patch",
      subscription,
      generation: 1,
      serverNowMs: Date.now(),
      seq: 1,
      put: [],
      remove: [],
      grants: { actions: [], needsIdentity: ["add"], queries: [] },
    }),
  );

  expect(couldAdd).toBe(true);
  expect(app.state.kind === "ready" && app.state.actions.has("add")).toBe(false);
  expect(app.state.kind === "ready" && app.state.needsIdentity.has("add")).toBe(true);
  expect(rendered()).toMatchObject({ kind: "ready", notes: ["first"] });
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

  expect(whileAway).toEqual({ kind: "connecting", offered: "false", notes: [] });
  expect(server.last(AUTHORITY_EVENTS.unsubscribe)!.payload).toEqual({ subscription });
  expect(askedWhileAway).toBe(0);
  expect(server.count(AUTHORITY_EVENTS.capabilities)).toBe(askedBefore + 1);
});

it("asks for nothing before the room is joined", async () => {
  await mount(<Notes />, false);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));

  expect(rendered()).toMatchObject({ kind: "connecting", offered: "false" });
  expect(server.count(AUTHORITY_EVENTS.capabilities)).toBe(0);
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(0);
});

/** The server's answer to the capability request, offering the app. */
const offer = async (serverNowMs = Date.now(), roomEpoch = "epoch-1") => {
  await act(async () =>
    server.last(AUTHORITY_EVENTS.capabilities)!.ack!({
      ok: true,
      value: {
        protocol: 1,
        roomEpoch,
        serverNowMs,
        apps: [{ instance: "notes.1", app: "notes", major: 1, surface: "panel" }],
      },
    }),
  );
};

/** The first view, sent to whichever subscription asked last. */
const sendView = async (serverNowMs = Date.now()) => {
  const subscribe = server.last(AUTHORITY_EVENTS.subscribe)!;
  await act(async () => {
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "replace",
      subscription: subscribe.payload.subscription,
      generation: 1,
      serverNowMs,
      part: 0,
      last: true,
      rows: [],
      grants: { actions: ["add"], needsIdentity: [], queries: [] },
    });
    subscribe.ack!({ ok: true, value: null });
  });
};

for (const code of ["rate-limited", "capacity", "busy", "invalid-input", "unknown-app"] as const) {
  it(`keeps a view on its way and asks again when a subscribe is refused with ${code}`, async () => {
    await mount();
    await offer();
    const shown: string[] = [];
    let result: unknown;
    await act(async () => {
      void app.act("add", { text: "while refused" }).then((value) => {
        result = value;
      });
    });
    await act(async () => {
      server.last(AUTHORITY_EVENTS.subscribe)!.ack!({ ok: false, code });
      await vi.advanceTimersByTimeAsync(0);
    });
    shown.push(rendered().kind ?? "");
    const asked = server.count(AUTHORITY_EVENTS.subscribe);
    // Asked what it offers again, the server answers as it did before.
    if (server.count(AUTHORITY_EVENTS.capabilities) > 1) await offer();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    shown.push(rendered().kind ?? "");
    await sendView();
    const sent = server.last(AUTHORITY_EVENTS.act);
    await act(async () => {
      sent?.ack!({ ok: true, value: null, revision: 2 });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(shown).toEqual(["connecting", "connecting"]);
    expect(server.count(AUTHORITY_EVENTS.subscribe)).toBeGreaterThan(asked);
    expect(rendered()).toMatchObject({ kind: "ready", offered: "true" });
    // The action waited for the view instead of failing.
    expect(sent?.payload).toMatchObject({ action: "add", input: { text: "while refused" } });
    expect(result).toMatchObject({ ok: true });
  });
}

for (const code of ["stale-epoch", "not-in-room"] as const) {
  it(`asks what the server offers again and stays on its way when a subscribe is refused with ${code}`, async () => {
    await mount();
    await offer();
    const asked = server.count(AUTHORITY_EVENTS.capabilities);
    await act(async () => {
      server.last(AUTHORITY_EVENTS.subscribe)!.ack!({ ok: false, code });
      await vi.advanceTimersByTimeAsync(0);
    });
    const meanwhile = rendered().kind;
    const refreshed = server.count(AUTHORITY_EVENTS.capabilities) > asked;
    // The room was recreated: the answer names a new one, and the client
    // subscribes there.
    await offer(Date.now(), "epoch-2");
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const subscribedAgain = server.last(AUTHORITY_EVENTS.subscribe)!.payload.roomEpoch;
    await sendView();

    expect(meanwhile).toBe("connecting");
    expect(refreshed).toBe(true);
    expect(subscribedAgain).toBe("epoch-2");
    expect(rendered()).toMatchObject({ kind: "ready", offered: "true" });
  });
}

it("spaces its subscribe attempts out while the server keeps refusing them", async () => {
  await mount();
  await offer();
  const at: number[] = [];
  const started = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      server.last(AUTHORITY_EVENTS.subscribe)!.ack!({ ok: false, code: "rate-limited" });
      await vi.advanceTimersByTimeAsync(0);
    });
    const count = server.count(AUTHORITY_EVENTS.subscribe);
    while (server.count(AUTHORITY_EVENTS.subscribe) === count) {
      await act(async () => vi.advanceTimersByTimeAsync(10));
      if (Date.now() - started > 120_000) break;
    }
    at.push(Date.now() - started);
  }
  const gaps = at.map((time, index) => time - (at[index - 1] ?? 0));

  expect(rendered().kind).toBe("connecting");
  // Each wait is longer than the one before it.
  for (let index = 1; index < gaps.length; index += 1) {
    expect(gaps[index]).toBeGreaterThan(gaps[index - 1]);
  }
});

it("asks again when a subscribe's answer comes too late and no view follows", async () => {
  await mount();
  await offer();
  const first = server.last(AUTHORITY_EVENTS.subscribe)!;
  // The answer is lost, and the refusal it carried arrives after the wait.
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  await act(async () => {
    first.ack!({ ok: false, code: "rate-limited" });
    await vi.advanceTimersByTimeAsync(0);
  });
  const meanwhile = rendered().kind;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  const askedAgain = server.count(AUTHORITY_EVENTS.subscribe);
  await sendView();

  expect(meanwhile).toBe("connecting");
  expect(askedAgain).toBeGreaterThan(1);
  expect(rendered()).toMatchObject({ kind: "ready", offered: "true" });
});

it("does not ask again when a subscribe's answer is lost but its view arrives", async () => {
  await mount();
  await offer();
  // The server took the subscribe: its view comes, only the answer is lost.
  const subscribe = server.last(AUTHORITY_EVENTS.subscribe)!;
  await act(async () => {
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "replace",
      subscription: subscribe.payload.subscription,
      generation: 1,
      serverNowMs: Date.now(),
      part: 0,
      last: true,
      rows: [],
      grants: { actions: ["add"], needsIdentity: [], queries: [] },
    });
  });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));

  expect(rendered()).toMatchObject({ kind: "ready", offered: "true" });
  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(1);
});

it("keeps a view that starts to come in parts after its answer was lost", async () => {
  await mount();
  await offer();
  const subscribe = server.last(AUTHORITY_EVENTS.subscribe)!;
  const part = (index: number, last: boolean) =>
    act(async () =>
      server.push(AUTHORITY_EVENTS.frame, {
        kind: "replace",
        subscription: subscribe.payload.subscription,
        generation: 1,
        serverNowMs: Date.now(),
        part: index,
        last,
        rows: [{ bucket: "notes", key: `n${index}`, value: { text: `note ${index}` } }],
        ...(index === 0 ? { grants: { actions: ["add"], needsIdentity: [], queries: [] } } : {}),
      }),
    );
  // The answer is lost, then the view's first part arrives, slowly.
  await act(async () => vi.advanceTimersByTimeAsync(5_100));
  await part(0, false);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  const askedWhileItCame = server.count(AUTHORITY_EVENTS.subscribe);
  await part(1, true);

  expect(askedWhileItCame).toBe(1);
  expect(rendered()).toMatchObject({ kind: "ready", notes: ["note 0", "note 1"] });
});

it("does not ask again after a lost answer when the server then revokes the view", async () => {
  await mount();
  await offer();
  const subscribe = server.last(AUTHORITY_EVENTS.subscribe)!;
  await act(async () => vi.advanceTimersByTimeAsync(5_100));
  await act(async () =>
    server.push(AUTHORITY_EVENTS.frame, {
      kind: "revoke",
      subscription: subscribe.payload.subscription,
      generation: 1,
      serverNowMs: Date.now(),
      reason: "forbidden",
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(60_000));

  expect(server.count(AUTHORITY_EVENTS.subscribe)).toBe(1);
  expect(rendered().kind).toBe("revoked");
});

it("still revokes the view when a subscribe is refused as forbidden", async () => {
  await mount();
  await offer();
  await act(async () => {
    server.last(AUTHORITY_EVENTS.subscribe)!.ack!({ ok: false, code: "forbidden" });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(rendered().kind).toBe("revoked");
});

it("stamps an action with the server's clock even when the client's is 30 seconds off", async () => {
  await mount();
  const serverAhead = 30_000;
  await offer(Date.now() + serverAhead);
  // Pressed before the view, and so before any frame has told the time.
  await act(async () => {
    void app.act("add", { text: "early" });
  });
  await sendView(Date.now() + serverAhead);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const sent = server.last(AUTHORITY_EVENTS.act)!;
  const issuedAtMs = (sent.payload.operation as { issuedAtMs: number }).issuedAtMs;

  expect(Math.abs(issuedAtMs - (Date.now() + serverAhead))).toBeLessThan(1_000);
});
