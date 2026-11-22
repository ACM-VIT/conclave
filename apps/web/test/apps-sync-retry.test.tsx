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
type SyncReply = Record<string, unknown> | undefined;

let root: Root;
let ctx: AppsContextValue;
const listeners = new Map<string, Set<Listener>>();
const fire = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args));
const syncTimes: number[] = [];
let answerSync: (attempt: number) => SyncReply = () => undefined;

const board = new Y.Doc();
board.getText("t").insert(0, "drawn before you joined");
const boardContent = () => ({ syncMessage: Y.encodeStateAsUpdate(board), stateVector: Y.encodeStateVector(board) });
const busy = { error: "App document is busy", retryable: true, retryAfterMs: 250 };

const socket = {
  connected: true,
  on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
  off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
  emit: (event: string, _payload?: unknown, ack?: (response: unknown) => void) => {
    if (event !== "apps:yjs:sync" || typeof ack !== "function") return;
    syncTimes.push(Date.now());
    const reply = answerSync(syncTimes.length);
    if (reply) ack(reply);
  },
} as unknown as Socket;

function Probe() {
  ctx = useContext(AppsContext)!;
  return null;
}

const openBoard = async () => {
  await act(async () => fire("apps:state", { activeAppId: "board", locked: false }));
};
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const boardText = () => ctx.getDoc("board").getText("t").toString();
const gaps = () => syncTimes.slice(1).map((time, index) => time - syncTimes[index]);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners.clear();
  syncTimes.length = 0;
  answerSync = () => undefined;
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <AppsProvider socket={socket} apps={[{ id: "board", name: "Board" } as never]} isAdmin>
        <Probe />
      </AppsProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("retries a sync the server says to retry and loads the board once the server has room", async () => {
  answerSync = (attempt) => (attempt < 3 ? busy : boardContent());

  await openBoard();
  await wait(250 + 500);

  expect(syncTimes).toHaveLength(3);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("backs off 250 ms, 500 ms, 1 s, 2 s, then 4 s between retries", async () => {
  answerSync = () => ({ ...busy, retryAfterMs: 0 });

  await openBoard();
  await wait(250 + 500 + 1_000 + 2_000 + 4_000 + 4_000);

  expect(gaps()).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000]);
  expect(ctx.syncStatus).toBe("syncing");
});

it("waits as long as the server asks when that is longer than the backoff", async () => {
  answerSync = (attempt) => (attempt === 1 ? { ...busy, retryAfterMs: 3_000 } : boardContent());

  await openBoard();
  await wait(2_999);
  expect(syncTimes).toHaveLength(1);
  await wait(1);

  expect(syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
});

it("gives up after about 30 seconds and loads the board when asked to retry", async () => {
  answerSync = () => busy;

  await openBoard();
  await wait(40_000);
  const attempts = syncTimes.length;

  expect(ctx.syncStatus).toBe("failed");
  expect(syncTimes[syncTimes.length - 1] - syncTimes[0]).toBeLessThanOrEqual(30_000);
  await wait(10_000);
  expect(syncTimes).toHaveLength(attempts);

  answerSync = () => boardContent();
  await act(async () => ctx.retrySync());

  expect(syncTimes).toHaveLength(attempts + 1);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});

it("stops at once on an error the server does not mark as retryable", async () => {
  answerSync = () => ({ error: "App document too large to sync" });

  await openBoard();
  await wait(10_000);

  expect(syncTimes).toHaveLength(1);
  expect(ctx.syncStatus).toBe("failed");
});

it("syncs again when the socket reconnects", async () => {
  answerSync = () => undefined;
  await openBoard();
  expect(syncTimes).toHaveLength(1);

  answerSync = () => boardContent();
  await act(async () => fire("connect"));

  expect(syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.syncStatus).toBe("synced");
});
