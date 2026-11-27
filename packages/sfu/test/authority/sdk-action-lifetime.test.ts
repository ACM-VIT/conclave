import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  AUTHORITY_LIMITS,
  AUTHORITY_PROTOCOL,
  AuthorityClient,
  defineContract,
  s,
  type AuthorityResult,
  type AuthoritySocket,
} from "@conclave/apps-sdk/authority";

const contract = defineContract({
  id: "notes",
  major: 1,
  surface: "panel",
  actions: { add: { input: s.null(), receipt: s.null() } },
  queries: {},
  views: {},
});

type Reply = AuthorityResult<null>;
const success = { ok: true, value: null, revision: 2 } satisfies Reply;
const rejected = { ok: false, code: "rejected", reason: "closed" } satisfies Reply;
const rateLimited = { ok: false, code: "rate-limited", retryAfterMs: 30_000 } satisfies Reply;
const stale = { ok: false, code: "stale-generation" } satisfies Reply;
const ackTimeoutMs = 100;
const clients: AuthorityClient[] = [];

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

const setup = () => {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Listener>();
  let connected = true;
  const messages: {
    event: string;
    payload: Record<string, unknown>;
    ack?: (reply: unknown) => void;
  }[] = [];
  const socket: AuthoritySocket = {
    get connected() {
      return connected;
    },
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    emit: (event, payload, ack) => {
      messages.push({
        event,
        payload: payload as Record<string, unknown>,
        ack: ack as (reply: unknown) => void,
      });
    },
  };
  const push = (event: string, payload?: unknown) => listeners.get(event)?.(payload);
  const client = new AuthorityClient({ socket, ackTimeoutMs });
  clients.push(client);
  const session = client.open(contract);
  const last = (event: string) => [...messages].reverse().find((message) => message.event === event)!;
  const frame = () => ({
    subscription: last(AUTHORITY_EVENTS.subscribe).payload.subscription,
    generation: 1,
    serverNowMs: Date.now(),
  });
  const offer = (roomEpoch: string, supported = true) => {
    push(AUTHORITY_EVENTS.capabilitiesChanged, {
      protocol: AUTHORITY_PROTOCOL,
      roomEpoch,
      serverNowMs: Date.now(),
      apps: supported ? [{ app: "notes", major: 1, instance: "notes.1", surface: "panel" }] : [],
    });
    if (supported) last(AUTHORITY_EVENTS.subscribe).ack?.({ ok: true, value: null });
  };
  const ready = () =>
    push(AUTHORITY_EVENTS.frame, { ...frame(), kind: "replace", part: 0, last: true, rows: [], revision: 1 });
  const begin = () => {
    let outcome: Reply | undefined;
    const done = session.act("add", null).then((reply) => (outcome = reply));
    return { done, result: () => outcome };
  };
  return {
    client,
    session,
    offer,
    ready,
    begin,
    disconnect: () => {
      connected = false;
      push("disconnect");
    },
    reconnect: () => {
      connected = true;
      push("connect");
    },
    attempts: () => messages.filter(({ event }) => event === AUTHORITY_EVENTS.act),
    reply: (result: Reply) => last(AUTHORITY_EVENTS.act).ack!(result),
    revoke: () => push(AUTHORITY_EVENTS.frame, { ...frame(), kind: "revoke", reason: "forbidden" }),
  };
};

const waits = [
  { phase: "readiness", count: 0, possible: false },
  { phase: "ack", count: 1, possible: true },
  { phase: "lost reply retry", count: 1, possible: true },
  { phase: "rate-limit retry", count: 2, possible: true },
  { phase: "resubscribe retry", count: 1, possible: false },
  { phase: "resubscribe retry after loss", count: 2, possible: true },
] as const;
const endings = ["leave", "replacement", "unsupported"] as const;

it.each(waits.flatMap((wait) => endings.map((end) => ({ ...wait, end }))))(
  "ends a $phase wait immediately on $end",
  async ({ phase, count, possible, end }) => {
    const h = setup();
    h.offer("first");
    if (phase !== "readiness") h.ready();
    const action = h.begin();
    await vi.advanceTimersByTimeAsync(0);
    if (phase === "rate-limit retry" || phase === "resubscribe retry after loss") {
      await vi.advanceTimersByTimeAsync(ackTimeoutMs + 400);
      h.reply(phase === "rate-limit retry" ? rateLimited : stale);
    } else if (phase === "resubscribe retry") {
      h.reply(stale);
    } else if (phase === "lost reply retry") {
      await vi.advanceTimersByTimeAsync(ackTimeoutMs);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts()).toHaveLength(count);
    expect(action.result()).toBeUndefined();

    if (end === "leave") h.client.left();
    if (end === "replacement") h.offer("second");
    if (end === "unsupported") h.offer("first", false);
    await vi.advanceTimersByTimeAsync(0);

    expect(action.result()).toEqual({
      ok: false,
      code: possible ? "unknown-outcome" : end === "unsupported" ? "unsupported" : "not-in-room",
    });
    if (end === "leave") {
      h.client.joined();
      h.offer("first");
    }
    if (end === "unsupported") h.offer("first");
    h.ready();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(h.attempts()).toHaveLength(count);
  },
);

it("does not carry actions from before or during a leave into the next join", async () => {
  const h = setup();
  const before = h.begin();
  h.client.left();
  const away = h.begin();
  h.client.joined();
  h.offer("second");
  h.ready();
  await vi.advanceTimersByTimeAsync(0);

  expect(before.result()).toEqual({ ok: false, code: "not-in-room" });
  expect(away.result()).toEqual({ ok: false, code: "not-in-room" });
  expect(h.attempts()).toHaveLength(0);

  const next = h.begin();
  await vi.advanceTimersByTimeAsync(0);
  h.reply(success);
  expect(await next.done).toMatchObject({ ok: true });
  expect(h.attempts()[0].payload.roomEpoch).toBe("second");
});

it("binds actions waiting on the first capability to that room", async () => {
  const h = setup();
  const pending = h.begin();
  h.offer("first");
  h.offer("second");
  h.ready();
  await vi.advanceTimersByTimeAsync(0);

  expect(pending.result()).toEqual({ ok: false, code: "not-in-room" });
  expect(h.attempts()).toHaveLength(0);
});

it.each(["first", "second"])("retains the room epoch across a disconnect and reconnect to %s", async (epoch) => {
  const h = setup();
  h.offer("first");
  h.ready();
  const pending = h.begin();
  await vi.advanceTimersByTimeAsync(0);
  h.disconnect();
  await vi.advanceTimersByTimeAsync(ackTimeoutMs + 400);
  h.reconnect();
  h.offer(epoch);
  h.ready();
  await vi.advanceTimersByTimeAsync(0);

  if (epoch === "first") {
    const [first, retry] = h.attempts();
    expect(retry?.payload.operation).toEqual(first.payload.operation);
    expect(retry?.payload.roomEpoch).toBe("first");
    h.reply(success);
    expect(await pending.done).toMatchObject({ ok: true });
  } else {
    expect(h.attempts()).toHaveLength(1);
    expect(pending.result()).toEqual({ ok: false, code: "unknown-outcome" });
  }
});

const replyEndings = ["leave", "replacement", "unsupported", "revoke", "close", "deadline"] as const;
const endDeadline = () => vi.setSystemTime(Date.now() + AUTHORITY_LIMITS.operationMaxAgeMs);

it.each([success, rejected, rateLimited].flatMap((reply) => replyEndings.map((end) => ({ reply, end }))))(
  "keeps $reply when received before $end",
  async ({ reply, end }) => {
    const h = setup();
    h.offer("first");
    h.ready();
    const action = h.begin();
    await vi.advanceTimersByTimeAsync(0);
    h.reply(reply);
    if (end === "leave") h.client.left();
    if (end === "replacement") h.offer("second");
    if (end === "unsupported") h.offer("first", false);
    if (end === "revoke") h.revoke();
    if (end === "close") h.session.close();
    if (end === "deadline") endDeadline();

    expect(await action.done).toEqual(reply);
  },
);

it.each(["leave", "deadline"] as const)("ignores an ack received after %s", async (end) => {
  const h = setup();
  h.offer("first");
  h.ready();
  const action = h.begin();
  await vi.advanceTimersByTimeAsync(0);
  if (end === "leave") h.client.left();
  else endDeadline();
  h.reply(success);

  expect(await action.done).toEqual({ ok: false, code: "unknown-outcome" });
});

it("keeps an earlier attempt unresolved when a rate limit arrives before teardown", async () => {
  const h = setup();
  h.offer("first");
  h.ready();
  const action = h.begin();
  await vi.advanceTimersByTimeAsync(ackTimeoutMs + 400);
  expect(h.attempts()).toHaveLength(2);
  h.reply(rateLimited);
  h.revoke();

  expect(await action.done).toEqual({ ok: false, code: "unknown-outcome" });
});
