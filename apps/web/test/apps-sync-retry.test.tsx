// @vitest-environment happy-dom
import { StrictMode, act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Socket } from "socket.io-client";
import {
  AppsContext,
  AppsProvider,
} from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
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
  const updatePayloads: Array<{ update: Uint8Array; replicaId?: string }> = [];
  const syncPayloads: Array<Record<string, unknown>> = [];
  const awarenessPayloads: Array<{ awarenessUpdate: Uint8Array; clientId: number }> = [];
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
      if (event === "apps:yjs:update") {
        uploads.push((payload as { update: Uint8Array }).update);
        updatePayloads.push(payload as { update: Uint8Array; replicaId?: string });
      }
      if (event === "apps:yjs:sync") syncPayloads.push(payload as Record<string, unknown>);
      if (event === "apps:awareness") awarenessPayloads.push(payload as { awarenessUpdate: Uint8Array; clientId: number });
      if (event !== "apps:yjs:sync" || typeof ack !== "function") return;
      syncTimes.push(Date.now());
      const reply = control.answerSync(syncTimes.length);
      if (reply) ack(reply);
      else unanswered.push(ack);
    },
  } as unknown as Socket;
  const fire = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args));
  return { socket, syncTimes, unanswered, uploads, updatePayloads, syncPayloads, awarenessPayloads, pendingState, control, fire };
};

let root: Root;
let ctx: AppsContextValue;
let first: ReturnType<typeof makeSocket>;

let mountedDoc: Y.Doc | null = null;

function Probe() {
  ctx = useContext(AppsContext)!;
  return ctx.state.activeAppId === "board" ? <BoardConsumer /> : null;
}

function BoardConsumer() {
  mountedDoc = useAppDoc("board").doc;
  return null;
}

const boardApps = [{ id: "board", name: "Board" } as never];
const mount = async (socket: Socket, { isAdmin = true, apps = boardApps }: { isAdmin?: boolean; apps?: never[] } = {}) => {
  await act(async () =>
    root.render(
      <AppsProvider socket={socket} apps={apps} isAdmin={isAdmin}>
        <Probe />
      </AppsProvider>,
    ),
  );
};
const appState = async (activeAppId: string | null, locked = false) => {
  await act(async () => first.fire("apps:state", { activeAppId, locked }));
};
const openBoard = () => appState("board");
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const boardText = () => ctx.getDoc("board").getText("t").toString();
const draw = async (text: string) => {
  await act(async () => ctx.getDoc("board").getText("t").insert(0, text));
};
const lastReplica = () => first.updatePayloads.at(-1)!.replicaId!;
const refuse = async (replicaId: string) => {
  await act(async () => first.fire("apps:yjs:refused", { appId: "board", replicaId, reason: "timed-out" }));
};
const contentOf = (doc: Y.Doc) => ({ syncMessage: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) });
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

it("retries a refusal from an older SFU and opens the board once a sync is answered", async () => {
  first.control.answerSync = (attempt) => (attempt < 3 ? { error: "Too many app sync requests" } : boardContent());

  await openBoard();
  await wait(250);
  expect(first.syncTimes).toHaveLength(2);
  expect(ctx.syncStatus).toBe("syncing");
  await wait(500);

  expect(first.syncTimes).toHaveLength(3);
  expect(ctx.syncStatus).toBe("synced");
  expect(boardText()).toBe("drawn before you joined");
});

it("fails at once on a refusal that is not worth retrying", async () => {
  first.control.answerSync = () => ({ error: "App not active" });

  await openBoard();
  expect(ctx.syncStatus).toBe("failed");
  await wait(40_000);

  expect(first.syncTimes).toHaveLength(1);
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

it("tells the server it can retry a sync and names its copy of the board with an id it picks", async () => {
  first.control.answerSync = () => boardContent();
  await openBoard();

  await draw("mine ");
  await draw("more ");

  expect(first.syncPayloads[0]).toMatchObject({ appId: "board", canRetry: true });
  const [one, two] = first.updatePayloads.slice(-2).map((payload) => payload.replicaId);
  expect(one).toEqual(expect.any(String));
  expect(two).toBe(one);
  expect(one).not.toBe(ctx.getDoc("board").guid);
});

it("sends nothing back after a sync that left it with nothing the server lacks", async () => {
  const erased = new Y.Doc();
  erased.getText("t").insert(0, "drawn and erased");
  erased.getText("t").delete(0, 10);
  first.control.answerSync = () => contentOf(erased);

  await openBoard();

  expect(boardText()).toBe("erased");
  expect(ctx.syncStatus).toBe("synced");
  expect(first.uploads).toEqual([]);
});

it("sends no change while the app is locked for a participant who is not a host", async () => {
  await mount(first.socket, { isAdmin: false });
  first.control.answerSync = () => boardContent();
  await appState("board", true);

  await draw("mine ");

  expect(ctx.syncStatus).toBe("synced");
  expect(first.uploads).toEqual([]);
});

it("rebuilds a copy that changed while locked before it sends again, so later changes integrate", async () => {
  await mount(first.socket, { isAdmin: false });
  first.control.answerSync = () => boardContent();
  await appState("board", true);
  await draw("racing ");

  await appState("board", false);
  expect(first.syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
  expect(ctx.rejectedChangeAt).toBeNull();
  await draw("after ");

  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(board));
  for (const upload of first.uploads) Y.applyUpdate(server, upload);
  expect(server.store.pendingStructs).toBeNull();
  expect(server.getText("t").toString()).toBe("after drawn before you joined");
});

it("rebuilds a seeded copy that opened while locked once writes are allowed", async () => {
  const seeded = () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "seed ");
    return doc;
  };
  await mount(first.socket, { isAdmin: false, apps: [{ id: "board", name: "Board", createDoc: seeded } as never] });
  first.control.answerSync = () => boardContent();
  await appState("board", true);
  expect(boardText()).toContain("seed ");
  expect(first.uploads).toEqual([]);

  await appState("board", false);

  expect(first.syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
  expect(first.uploads).toEqual([]);
});

it("rebuilds a seeded copy when the app unlocks before its first sync answers", async () => {
  const seeded = () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "seed ");
    return doc;
  };
  await mount(first.socket, { isAdmin: false, apps: [{ id: "board", name: "Board", createDoc: seeded } as never] });
  await appState("board", true);

  await appState("board", false);
  expect(first.unanswered).toHaveLength(2);
  await act(async () => first.unanswered[1](boardContent()));
  await act(async () => first.unanswered[0](boardContent()));

  expect(boardText()).toBe("drawn before you joined");
  expect(first.uploads).toEqual([]);
  expect(ctx.syncStatus).toBe("synced");
});

it("applies no sync reply that lands after it unmounts", async () => {
  await openBoard();
  await draw("mine ");
  const uploads = first.uploads.length;
  const ack = first.unanswered.shift()!;

  await act(async () => {
    root.unmount();
    ack(boardContent());
  });
  root = createRoot(document.createElement("div"));

  expect(first.uploads).toHaveLength(uploads);
});

it("syncs the open app through a StrictMode effect replay even when replies arrive at once", async () => {
  const live = makeSocket("board");
  live.control.answerSync = () => boardContent();

  await act(async () =>
    root.render(
      <StrictMode>
        <AppsProvider socket={live.socket} apps={boardApps} isAdmin>
          <Probe />
        </AppsProvider>
      </StrictMode>,
    ),
  );

  expect(ctx.syncStatus).toBe("synced");
  expect(boardText()).toBe("drawn before you joined");
  expect(mountedDoc?.isDestroyed).toBe(false);
  expect(live.syncTimes).toHaveLength(1);
});

it("rebuilds a copy that changed before the participant became a host", async () => {
  await mount(first.socket, { isAdmin: false });
  first.control.answerSync = () => boardContent();
  await appState("board", true);
  await draw("racing ");

  await mount(first.socket, { isAdmin: true });

  expect(first.syncTimes).toHaveLength(2);
  expect(boardText()).toBe("drawn before you joined");
});

it("keeps the refused board on screen until the server's copy arrives, then shows only what the server kept", async () => {
  first.control.answerSync = (attempt) => (attempt === 1 ? boardContent() : undefined);
  await openBoard();
  const refusedDoc = ctx.getDoc("board");
  await draw("mine ");
  const uploads = first.uploads.length;

  await refuse(lastReplica());
  expect(mountedDoc).toBe(refusedDoc);
  expect(ctx.getDoc("board")).toBe(refusedDoc);
  expect(ctx.syncStatus).toBe("syncing");
  expect(ctx.isRebuilding).toBe(true);
  await draw("lost ");
  await act(async () => first.unanswered.shift()!(boardContent()));

  expect(ctx.isRebuilding).toBe(false);
  expect(ctx.getDoc("board")).not.toBe(refusedDoc);
  expect(mountedDoc).toBe(ctx.getDoc("board"));
  expect(boardText()).toBe("drawn before you joined");
  expect(first.uploads).toHaveLength(uploads);
  expect(first.syncTimes).toHaveLength(2);
  expect(ctx.rejectedChangeAt).toEqual(expect.any(Number));
  expect(ctx.syncStatus).toBe("synced");
});

it("keeps a peer's change that lands while it rebuilds the board", async () => {
  first.control.answerSync = (attempt) => (attempt === 1 ? boardContent() : undefined);
  await openBoard();
  await draw("mine ");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(board));
  const before = Y.encodeStateVector(peer);
  peer.getText("t").insert(0, "peer ");
  const peerChange = Y.encodeStateAsUpdate(peer, before);

  await refuse(lastReplica());
  await act(async () => first.fire("apps:yjs:update", { appId: "board", update: peerChange }));
  await act(async () => first.unanswered.shift()!(boardContent()));

  expect(boardText()).toBe("peer drawn before you joined");
});

it("rebuilds from the server alone, not from what the app's factory seeds", async () => {
  const seeded = () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "seed ");
    return doc;
  };
  await mount(first.socket, { apps: [{ id: "board", name: "Board", createDoc: seeded } as never] });
  first.control.answerSync = () => boardContent();
  await openBoard();
  await draw("mine ");
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(board));

  first.control.answerSync = () => contentOf(server);
  await refuse(lastReplica());

  expect(boardText()).toBe("drawn before you joined");
});

it("takes the replaced copy's cursor away from peers and from the new copy", async () => {
  first.control.answerSync = (attempt) => (attempt === 1 ? boardContent() : undefined);
  await openBoard();
  const before = ctx.getAwareness("board");
  await act(async () => before.setLocalState({ cursor: [1, 2] }));
  const oldClient = before.clientID;
  const snapshot = encodeAwarenessUpdate(before, [oldClient]);
  await draw("mine ");

  await refuse(lastReplica());
  await act(async () => first.unanswered.shift()!({ ...boardContent(), awarenessUpdate: snapshot }));

  const after = ctx.getAwareness("board");
  expect(after.clientID).not.toBe(oldClient);
  expect(after.getStates().has(oldClient)).toBe(false);
  const peer = new Awareness(new Y.Doc());
  applyAwarenessUpdate(peer, snapshot, "remote");
  for (const { awarenessUpdate } of first.awarenessPayloads) applyAwarenessUpdate(peer, awarenessUpdate, "remote");
  expect(peer.getStates().has(oldClient)).toBe(false);
  peer.destroy();
});

it("destroys its documents and presence when it unmounts", async () => {
  first.control.answerSync = () => boardContent();
  await openBoard();
  const doc = ctx.getDoc("board");
  const awareness = ctx.getAwareness("board");
  await act(async () => awareness.setLocalState({ cursor: [1, 2] }));

  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));

  expect(doc.isDestroyed).toBe(true);
  expect(awareness.getLocalState()).toBeNull();
});

it("starts the rebuild again when asked to retry after it gave up", async () => {
  first.control.answerSync = (attempt) => (attempt === 1 ? boardContent() : busy);
  await openBoard();
  const refusedDoc = ctx.getDoc("board");
  await draw("mine ");
  const uploads = first.uploads.length;
  await refuse(lastReplica());
  await wait(30_000);
  expect(ctx.syncStatus).toBe("failed");
  expect(mountedDoc).toBe(refusedDoc);

  first.control.answerSync = () => boardContent();
  await act(async () => ctx.retrySync());

  expect(mountedDoc).not.toBe(refusedDoc);
  expect(boardText()).toBe("drawn before you joined");
  expect(first.uploads).toHaveLength(uploads);
  expect(ctx.syncStatus).toBe("synced");
});

it("tells a refusal of the old copy from one of the new copy even when the app reuses a doc guid", async () => {
  await mount(first.socket, { apps: [{ id: "board", name: "Board", createDoc: () => new Y.Doc({ guid: "board" }) } as never] });
  first.control.answerSync = () => boardContent();
  await openBoard();
  await draw("one ");
  const oldReplica = lastReplica();
  await refuse(oldReplica);
  await draw("two ");
  const newReplica = lastReplica();
  expect(newReplica).not.toBe(oldReplica);

  await refuse(oldReplica);
  expect(first.syncTimes).toHaveLength(2);
  await refuse(newReplica);
  expect(first.syncTimes).toHaveLength(3);
});

it("ignores a refusal for a copy it has already replaced", async () => {
  first.control.answerSync = () => boardContent();
  await openBoard();
  await draw("mine ");
  const replicaId = lastReplica();
  await refuse(replicaId);
  const rejectedAt = ctx.rejectedChangeAt;

  await wait(1_000);
  await refuse(replicaId);

  expect(first.syncTimes).toHaveLength(2);
  expect(ctx.rejectedChangeAt).toBe(rejectedAt);
});

it("forgets a refused change once the app closes", async () => {
  first.control.answerSync = () => boardContent();
  await openBoard();
  await draw("mine ");
  await refuse(lastReplica());
  expect(ctx.rejectedChangeAt).toEqual(expect.any(Number));

  await appState(null);
  expect(ctx.rejectedChangeAt).toBeNull();
  await openBoard();
  expect(ctx.rejectedChangeAt).toBeNull();
});
