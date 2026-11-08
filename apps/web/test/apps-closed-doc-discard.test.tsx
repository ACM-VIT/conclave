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

let root: Root;
let ctx: AppsContextValue;
const listeners = new Map<string, Listener>();
const emitted: Array<{ event: string; payload: unknown }> = [];

const socket = {
  connected: true,
  on: (event: string, listener: Listener) => listeners.set(event, listener),
  off: (event: string) => listeners.delete(event),
  emit: (event: string, payload?: unknown, ack?: (response: unknown) => void) => {
    emitted.push({ event, payload });
    if (event === "apps:yjs:sync" && typeof ack === "function") {
      // The server's copy of the app is empty: it was destroyed on close.
      ack({ syncMessage: null, stateVector: Y.encodeStateVector(new Y.Doc()) });
    }
  },
} as unknown as Socket;

function Probe() {
  ctx = useContext(AppsContext)!;
  return null;
}

const serverState = async (activeAppId: string | null) => {
  await act(async () => listeners.get("apps:state")!({ activeAppId, locked: false }));
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners.clear();
  emitted.length = 0;
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
});

it("does not resurrect a closed app's content when it is reopened", async () => {
  await serverState("board");
  const firstDoc = ctx.getDoc("board");
  firstDoc.getMap("shapes").set("circle", 1);

  await serverState(null);
  emitted.length = 0;
  await serverState("board");

  const reopened = ctx.getDoc("board");
  expect(reopened).not.toBe(firstDoc);
  expect(reopened.getMap("shapes").get("circle")).toBeUndefined();
  // Nothing sent to the server carries the closed app's old content.
  for (const upload of emitted.filter((entry) => entry.event === "apps:yjs:update")) {
    const received = new Y.Doc();
    Y.applyUpdate(received, (upload.payload as { update: Uint8Array }).update);
    expect(received.getMap("shapes").get("circle")).toBeUndefined();
  }
});

it("discards the closed document when close and reopen land in one React commit", async () => {
  await serverState("board");
  const firstDoc = ctx.getDoc("board");
  firstDoc.getMap("shapes").set("circle", 1);

  await act(async () => {
    listeners.get("apps:state")!({ activeAppId: null, locked: false });
    listeners.get("apps:state")!({ activeAppId: "board", locked: false });
  });

  const reopened = ctx.getDoc("board");
  expect(reopened).not.toBe(firstDoc);
  expect(reopened.getMap("shapes").get("circle")).toBeUndefined();
});
