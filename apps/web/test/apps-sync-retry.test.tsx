// @vitest-environment happy-dom
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import {
  AppsContext,
  AppsProvider,
} from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;
type SyncReply = Record<string, unknown> | undefined;

const board = new Y.Doc();
board.getText("t").insert(0, "drawn before you joined");
const boardContent = () => ({ syncMessage: Y.encodeStateAsUpdate(board), stateVector: Y.encodeStateVector(board) });
const busy = { error: "App document is busy", retryable: true, retryAfterMs: 250 };

const makeSocket = (activeAppId: string | null = null) => {
  const listeners = new Map<string, Set<Listener>>();
  const syncTimes: number[] = [];
  const unanswered: Ack[] = [];
  const uploads: Uint8Array[] = [];
  const control = { answerSync: (_attempt: number): SyncReply => undefined, getState: true };
  const pendingState: Ack[] = [];
  const socket = {
    connected: true,
    on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    emit: (event: string, payload?: unknown, ack?: Ack) => {
      if (event === "apps:getState" && typeof payload === "function") {
        if (control.getState) (payload as Ack)({ activeAppId, locked: false });
        else pendingState.push(payload as Ack);
        return;
      }
      if (event === "apps:yjs:update") uploads.push((payload as { update: Uint8Array }).update);
      if (event !== "apps:yjs:sync" || typeof ack !== "function") return;
      syncTimes.push(Date.now());
      const reply = control.answerSync(syncTimes.length);
      if (reply) ack(reply);
      else unanswered.push(ack);
    },
  } as unknown as Socket;
  const fire = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args));
  return { socket, syncTimes, unanswered, uploads, pendingState, control, fire };
};

let root: Root;
let ctx: AppsContextValue;
let first: ReturnType<typeof makeSocket>;

function Probe() {
  ctx = useContext(AppsContext)!;
  return null;
}

const mount = async (socket: Socket) => {
  await act(async () =>
    root.render(
      <AppsProvider socket={socket} apps={[{ id: "board", name: "Board" } as never]} isAdmin>
        <Probe />
      </AppsProvider>,
    ),
  );
};
const appState = async (activeAppId: string | null) => {
  await act(async () => first.fire("apps:state", { activeAppId, locked: false }));
};
const openBoard = () => appState("board");
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const boardText = () => ctx.getDoc("board").getText("t").toString();
const gaps = () => first.syncTimes.slice(1).map((time, index) => time - first.syncTimes[index]);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  first = makeSocket();
  root = createRoot(document.createElement("div"));
  await mount(first.socket);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("retries a sync the server says to retry and loads the board once the server has room", async () => {
  first.control.answerSync = (attempt) => (attempt < 3 ? busy : boardContent());

  await openBoard();
  await wait(250 + 500);

  expect(first.syncTimes).toHaveLength(3);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("backs off 250 ms, 500 ms, 1 s, 2 s, then 4 s between retries", async () => {
  first.control.answerSync = () => ({ ...busy, retryAfterMs: 0 });

  await openBoard();
  await wait(250 + 500 + 1_000 + 2_000 + 4_000 + 4_000);

  expect(gaps()).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000]);
  expect(ctx.syncStatus).toBe("syncing");
});

it("waits as long as the server asks when that is longer than the backoff", async () => {
  first.control.answerSync = (attempt) => (attempt === 1 ? { ...busy, retryAfterMs: 3_000 } : boardContent());

  await openBoard();
  await wait(2_999);
  expect(first.syncTimes).toHaveLength(1);
  await wait(1);

  expect(first.syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
});

it("ignores a retry hint that is not a usable number", async () => {
  first.control.answerSync = (attempt) =>
    attempt === 1 ? { ...busy, retryAfterMs: Number.POSITIVE_INFINITY } : boardContent();

  await openBoard();
  await wait(250);

  expect(first.syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
});

it("gives up after about 30 seconds and loads the board when asked to retry", async () => {
  first.control.answerSync = () => busy;

  await openBoard();
  await wait(40_000);
  const attempts = first.syncTimes.length;

  expect(ctx.syncStatus).toBe("failed");
  expect(first.syncTimes[attempts - 1] - first.syncTimes[0]).toBeLessThanOrEqual(30_000);
  await wait(10_000);
  expect(first.syncTimes).toHaveLength(attempts);

  first.control.answerSync = () => boardContent();
  await act(async () => ctx.retrySync());

  expect(first.syncTimes).toHaveLength(attempts + 1);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("gives up within 30 seconds when the server never answers", async () => {
  await openBoard();
  await wait(29_999);
  expect(ctx.syncStatus).toBe("syncing");
  await wait(1);

  expect(ctx.syncStatus).toBe("failed");
});

it("stops at once on an error the server does not mark as retryable", async () => {
  first.control.answerSync = () => ({ error: "App document too large to sync" });

  await openBoard();
  await wait(10_000);

  expect(first.syncTimes).toHaveLength(1);
  expect(ctx.syncStatus).toBe("failed");
});

it("reports a sync answer it cannot apply as failed", async () => {
  first.control.answerSync = () => ({ stateVector: Y.encodeStateVector(board) });

  await openBoard();

  expect(ctx.syncStatus).toBe("failed");
});

it("reports an empty sync update as failed", async () => {
  first.control.answerSync = () => ({ syncMessage: new Uint8Array(0), stateVector: Y.encodeStateVector(board) });

  await openBoard();

  expect(ctx.syncStatus).toBe("failed");
});

it("settles a sync whose state vector is unreadable", async () => {
  first.control.answerSync = () => ({ syncMessage: Y.encodeStateAsUpdate(board), stateVector: new Uint8Array(0) });

  await openBoard();

  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).not.toBe("syncing");
});

it("keeps retrying through a disconnect and gives up after about 30 seconds", async () => {
  first.control.answerSync = () => busy;
  await openBoard();
  (first.socket as { connected: boolean }).connected = false;

  await wait(30_000);
  expect(ctx.syncStatus).toBe("failed");

  (first.socket as { connected: boolean }).connected = true;
  first.control.answerSync = () => boardContent();
  await act(async () => ctx.retrySync());
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("starts no sync after it unmounts", async () => {
  const late = makeSocket("board");
  late.control.getState = false;
  await mount(late.socket);

  await act(async () => root.unmount());
  late.pendingState.shift()!({ activeAppId: "board", locked: false });
  await wait(30_000);

  expect(late.syncTimes).toHaveLength(0);
  root = createRoot(document.createElement("div"));
});

it("does not bring back a closed board when an old sync answer lands after it reopens", async () => {
  await openBoard();
  const oldAnswer = first.unanswered.shift()!;
  await act(async () => ctx.getDoc("board").getText("t").insert(0, "drawn on the closed board"));
  const uploadsBeforeClose = first.uploads.length;
  first.control.answerSync = () => ({ syncMessage: Y.encodeStateAsUpdate(new Y.Doc()), stateVector: Y.encodeStateVector(new Y.Doc()) });

  await act(async () => {
    first.fire("apps:state", { activeAppId: null, locked: false });
    oldAnswer(boardContent());
    first.fire("apps:state", { activeAppId: "board", locked: false });
  });

  expect(boardText()).toBe("");
  expect(first.syncTimes).toHaveLength(2);
  expect(ctx.syncStatus).toBe("synced");
  for (const upload of first.uploads.slice(uploadsBeforeClose)) {
    const received = new Y.Doc();
    Y.applyUpdate(received, upload);
    expect(received.getText("t").toString()).not.toContain("drawn on the closed board");
  }
});

it("keeps the new board's retry on schedule when an old reply lands", async () => {
  await openBoard();
  const oldAnswer = first.unanswered.shift()!;
  first.control.answerSync = (attempt) => (attempt === 2 ? busy : boardContent());

  await act(async () => {
    first.fire("apps:state", { activeAppId: null, locked: false });
    first.fire("apps:state", { activeAppId: "board", locked: false });
  });
  expect(first.syncTimes).toHaveLength(2);
  await act(async () => oldAnswer({ error: "App not active" }));
  await wait(250);

  expect(first.syncTimes).toHaveLength(3);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("syncs the board again on the new socket after a reconnect", async () => {
  await openBoard();
  expect(first.syncTimes).toHaveLength(1);
  const second = makeSocket("board");
  second.control.answerSync = () => boardContent();

  await mount(second.socket);
  first.unanswered.shift()!({ ...busy });
  await wait(30_000);

  expect(second.syncTimes).toHaveLength(1);
  expect(first.syncTimes).toHaveLength(1);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("drops the old sync when a reconnect lands in a room with no app open", async () => {
  await openBoard();
  const second = makeSocket(null);

  await mount(second.socket);
  first.unanswered.shift()!({ ...busy });
  await wait(30_000);

  expect(second.syncTimes).toHaveLength(0);
  expect(ctx.syncStatus).toBe("idle");
});
