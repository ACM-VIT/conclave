// @vitest-environment happy-dom
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { whiteboardApp } from "../../../packages/apps-sdk/src/apps/whiteboard/web/index";
import { getActivePageId, getPageElements } from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

let root: Root;
let container: HTMLDivElement;
let ctx: AppsContextValue;

const socket = {
  connected: true,
  on: (_event: string, _listener: Listener) => undefined,
  off: (_event: string, _listener: Listener) => undefined,
  emit: (event: string, payload?: unknown, ack?: Ack) => {
    if (event === "apps:getState" && typeof payload === "function") (payload as Ack)({ activeAppId: "whiteboard", locked: false });
    if (event === "apps:yjs:sync" && typeof ack === "function") {
      const empty = new Y.Doc();
      ack({ syncMessage: Y.encodeStateAsUpdate(empty), stateVector: Y.encodeStateVector(empty) });
    }
  },
} as unknown as Socket;

function Probe() {
  ctx = useContext(AppsContext)!;
  const Whiteboard = whiteboardApp.web!;
  return ctx.state.activeAppId === "whiteboard" ? <Whiteboard /> : null;
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pressure: 0.5, button: 0, buttons: type === "pointerup" ? 0 : 1 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const strokePoints = () => {
  const doc = ctx.getDoc("whiteboard");
  const strokes = getPageElements(doc, getActivePageId(doc)!).filter((element) => "points" in element);
  return strokes.map((stroke) => (stroke as unknown as { points: Array<{ x: number; y: number }> }).points);
};

it("writes a stroke from its pointer events as they arrive, with no animation frame, last point included", async () => {
  const canvas = [...container.querySelectorAll("canvas")].find((candidate) => candidate.onpointerdown !== undefined)!;
  canvas.setPointerCapture ??= () => undefined;
  canvas.releasePointerCapture ??= () => undefined;

  await act(async () => {
    canvas.dispatchEvent(pointer("pointerdown", 10, 10));
    canvas.dispatchEvent(pointer("pointermove", 20, 20));
  });
  const [during] = strokePoints();
  expect(during.length).toBeGreaterThanOrEqual(2);
  expect(during.at(-1)!.x - during[0].x).toBeCloseTo(10, 0);

  await act(async () => {
    canvas.dispatchEvent(pointer("pointermove", 40, 40));
    canvas.dispatchEvent(pointer("pointerup", 40, 40));
  });

  const [after] = strokePoints();
  expect(after.at(-1)!.x - after[0].x).toBeCloseTo(30, 0);
});

it("saves typed text from the text box's own change events", async () => {
  const canvas = [...container.querySelectorAll("canvas")].find((candidate) => candidate.onpointerdown !== undefined)!;
  canvas.setPointerCapture ??= () => undefined;
  canvas.releasePointerCapture ??= () => undefined;
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "8", code: "Digit8", bubbles: true }));
  });
  await act(async () => {
    canvas.dispatchEvent(pointer("pointerdown", 30, 30));
    canvas.dispatchEvent(pointer("pointerup", 30, 30));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  const editor = container.querySelector("textarea")!;
  expect(editor).not.toBeNull();

  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(editor, "hello");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const doc = ctx.getDoc("whiteboard");
  const texts = getPageElements(doc, getActivePageId(doc)!).filter((element) => element.type === "text");
  expect(texts.map((element) => (element as unknown as { text: string }).text)).toEqual(["hello"]);
});
