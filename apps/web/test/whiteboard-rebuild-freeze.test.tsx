// @vitest-environment happy-dom
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { whiteboardApp } from "../../../packages/apps-sdk/src/apps/whiteboard/web/index";
import { addPage, getPagesMap } from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

let root: Root;
let ctx: AppsContextValue;
const listeners = new Map<string, Set<Listener>>();
const uploads: Array<{ replicaId?: string }> = [];
const pendingSyncs: Ack[] = [];
let answerFirstSync = true;

const socket = {
  connected: true,
  on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
  off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
  emit: (event: string, payload?: unknown, ack?: Ack) => {
    if (event === "apps:getState" && typeof payload === "function") {
      (payload as Ack)({ activeAppId: "whiteboard", locked: false });
      return;
    }
    if (event === "apps:yjs:update") uploads.push(payload as { replicaId?: string });
    if (event !== "apps:yjs:sync" || typeof ack !== "function") return;
    if (answerFirstSync) {
      answerFirstSync = false;
      const empty = new Y.Doc();
      ack({ syncMessage: Y.encodeStateAsUpdate(empty), stateVector: Y.encodeStateVector(empty) });
    } else {
      pendingSyncs.push(ack);
    }
  },
} as unknown as Socket;

function Probe() {
  ctx = useContext(AppsContext)!;
  const Whiteboard = whiteboardApp.web!;
  return ctx.state.activeAppId === "whiteboard" ? <Whiteboard /> : null;
}

const pressUndo = async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }));
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <AppsProvider socket={socket} apps={[whiteboardApp]} isAdmin>
        <Probe />
      </AppsProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("ignores undo on the whiteboard while it is rebuilt from the server", async () => {
  const doc = ctx.getDoc("whiteboard");
  await act(async () => addPage(doc, { id: "undone", name: "Undone" }));
  await pressUndo();
  expect(getPagesMap(doc)?.has("undone") ?? false).toBe(false);

  await act(async () => addPage(doc, { id: "kept", name: "Kept" }));
  const replicaId = uploads.at(-1)!.replicaId!;
  await act(async () => listeners.get("apps:yjs:refused")?.forEach((listener) => listener({ appId: "whiteboard", replicaId, reason: "too-large" })));
  expect(ctx.isRebuilding).toBe(true);
  await pressUndo();

  expect(getPagesMap(doc)?.has("kept")).toBe(true);
  expect(pendingSyncs).toHaveLength(1);
});
