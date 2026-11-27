// @vitest-environment happy-dom
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";
import { whiteboardApp } from "../../../packages/apps-sdk/src/apps/whiteboard/web/index";
import {
  addElement,
  createWhiteboardDoc,
  ensureDefaultPage,
  getActivePageId,
  getPageElements,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import { NativeEmbedSession } from "../../../packages/apps-sdk/src/native-embed/session";
import { NativeWhiteboardEmbed } from "../../../packages/apps-sdk/src/native-embed/whiteboard/NativeWhiteboardEmbed";
import { base64FromBytes } from "../../../packages/apps-sdk/src/native-embed/protocol";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

let root: Root;
let container: HTMLDivElement;
let ctx: AppsContextValue;

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pressure: 0.5, button: 0, buttons: type === "pointerup" ? 0 : 1 });

const drawStroke = async (from: number) => {
  const canvas = [...container.querySelectorAll("canvas")].find((candidate) => candidate.onpointerdown !== undefined)!;
  canvas.setPointerCapture ??= () => undefined;
  canvas.releasePointerCapture ??= () => undefined;
  await act(async () => canvas.dispatchEvent(pointer("pointerdown", from, from)));
  for (let step = 1; step <= 12; step += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => canvas.dispatchEvent(pointer("pointermove", from + step * 4, from + step * 2)));
  }
  await act(async () => canvas.dispatchEvent(pointer("pointerup", from + 60, from + 30)));
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const elementIds = (doc: Y.Doc) => {
  const pageId = getActivePageId(doc);
  return pageId ? getPageElements(doc, pageId).map((element) => element.id).sort() : [];
};

const savedBoard = () => {
  const server = createWhiteboardDoc();
  server.clientID = 1;
  ensureDefaultPage(server);
  const pageId = getActivePageId(server)!;
  addElement(server, pageId, { id: "alice-1", type: "stroke", tool: "pen", points: [{ x: 1, y: 1 }, { x: 9, y: 9 }], color: "#fff", width: 2, opacity: 1 } as never);
  addElement(server, pageId, { id: "alice-2", type: "stroke", tool: "pen", points: [{ x: 5, y: 1 }, { x: 5, y: 9 }], color: "#fff", width: 2, opacity: 1 } as never);
  return server;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("edits made before an app's first sync", () => {
  it("cannot replace a saved whiteboard when a late joiner draws while its first sync is still on its way", async () => {
    const server = savedBoard();
    const listeners = new Map<string, Set<Listener>>();
    const uploads: Uint8Array[] = [];
    const socket = {
      connected: true,
      on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
      off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
      emit: (event: string, payload?: unknown, ack?: Ack) => {
        if (event === "apps:getState" && typeof payload === "function") {
          (payload as Ack)({ activeAppId: "whiteboard", locked: false });
          return;
        }
        if (event === "apps:yjs:sync" && typeof ack === "function") {
          setTimeout(() => ack({ syncMessage: Y.encodeStateAsUpdate(server), stateVector: Y.encodeStateVector(server), stagesParts: true }), 900);
          return;
        }
        if (event === "apps:yjs:update") {
          const { update } = payload as { update: Uint8Array };
          uploads.push(update);
          Y.applyUpdate(server, update);
        }
      },
    } as unknown as Socket;
    function Probe() {
      ctx = useContext(AppsContext)!;
      const Board = whiteboardApp.web!;
      return ctx.state.activeAppId ? <Board /> : null;
    }
    await act(async () =>
      root.render(
        <AppsProvider socket={socket} apps={[whiteboardApp as never]} user={{ id: "bob", name: "Bob" }} isAdmin>
          <Probe />
        </AppsProvider>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ctx.isRebuilding).toBe(true);
    await advance(50);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })));

    await drawStroke(20);
    await advance(1_500);

    expect(ctx.isRebuilding).toBe(false);
    expect(elementIds(server)).toEqual(["alice-1", "alice-2"]);
    expect(elementIds(ctx.getDoc("whiteboard"))).toEqual(["alice-1", "alice-2"]);

    await drawStroke(40);
    await advance(1_500);

    expect(elementIds(server)).toHaveLength(3);
    expect(elementIds(server)).toEqual(expect.arrayContaining(["alice-1", "alice-2"]));
    expect(elementIds(ctx.getDoc("whiteboard"))).toEqual(elementIds(server));
  });

  it("are refused by a native whiteboard embed until its first snapshot arrives", async () => {
    const scope = { callSessionId: "call-1-before-sync", appSessionId: "app-before-sync", appId: "whiteboard" };
    const outbox: string[] = [];
    let deliver: (raw: unknown) => unknown = () => "none";
    const session = new NativeEmbedSession(
      { platform: "ios", post: (message) => outbox.push(message), onMessage: (handler) => { deliver = handler; } },
      scope,
      new Y.Doc(),
    );
    let request = 0;
    const host = (type: string, payload: Record<string, unknown>) => {
      request += 1;
      return deliver(JSON.stringify({ v: 1, type, ...scope, requestId: `h-${request}`, payload }));
    };
    session.start();
    host("status", { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: "bob", userName: "Bob" });
    await act(async () => root.render(<NativeWhiteboardEmbed session={session} />));
    await advance(50);

    await drawStroke(20);
    await advance(500);
    expect(elementIds(session.doc)).toEqual([]);

    const server = savedBoard();
    await act(async () => {
      host("snapshot", {
        syncMessage: base64FromBytes(Y.encodeStateAsUpdate(server)),
        stateVector: base64FromBytes(Y.encodeStateVector(server)),
        awarenessUpdate: "",
      });
    });
    await advance(50);
    expect(elementIds(session.doc)).toEqual(["alice-1", "alice-2"]);

    await drawStroke(40);
    await advance(500);
    expect(elementIds(session.doc)).toHaveLength(3);
    expect(elementIds(session.doc)).toEqual(expect.arrayContaining(["alice-1", "alice-2"]));
    session.close();
  });
});
