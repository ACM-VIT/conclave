// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, startSpin, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import { encodeEnvelope } from "../../../packages/apps-sdk/src/native-embed/protocol";
import { NativeEmbedSession } from "../../../packages/apps-sdk/src/native-embed/session";

const harness = vi.hoisted(() => ({
  doc: null as unknown as import("yjs").Doc,
  panel: null as null | { onSort: () => void },
}));

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel", async (importActual) => {
  const actual = await importActual<typeof import("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel")>();
  return {
    WheelPanel: (props: Parameters<typeof actual.WheelPanel>[0]) => {
      harness.panel = props;
      return <actual.WheelPanel {...props} />;
    },
  };
});

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useAppDoc", () => ({
  useAppDoc: () => ({ doc: harness.doc, awareness: null, locked: false }),
}));

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useApps", () => ({
  useApps: () => ({ user: { id: "host-1", name: "Host" }, isAdmin: true, isReadOnly: false, participants: [] }),
}));

const { WheelWebApp } = await import("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelWebApp");
const { NativeWheelEmbed } = await import("../../../packages/apps-sdk/src/native-embed/wheel/NativeWheelEmbed");

const SCOPE = { callSessionId: "call-9-5e1c7a2b", appSessionId: "app-3d9f1b6c", appId: "wheel" };
const DURATION = 8_000;
const FRAME = 16;
const REVEAL_DELAY = 800;

let root: Root;
let container: HTMLDivElement;
let spinNumber = 0;

const startRemoteSpin = (receiverAhead = 0): number => {
  spinNumber += 1;
  const spin = {
    spinId: `spin-${spinNumber}`,
    entries: getEntries(harness.doc),
    winnerIndex: 1,
    startedAt: Date.now() - receiverAhead,
    durationMs: DURATION,
    turns: 8,
    jitter: 0.5,
    spunById: "someone-else",
    spunByName: "Grace",
  } as WheelSpin;
  act(() => startSpin(harness.doc, spin));
  return performance.now();
};

const rotation = (): string => container.querySelector("svg g")?.getAttribute("transform") ?? "";

type Moments = { dialStopped: number; revealed: number; editsOpen: number; guardOpen: number };
type Seen = { revealed: boolean; editsOpen: boolean; guardOpen: boolean };
type Probe = (key: keyof Seen) => boolean;

const stepsUntil = (expectedEnd: number): number[] => {
  const steps: number[] = [];
  let at = 0;
  const push = (size: number) => {
    steps.push(size);
    at += size;
  };
  while (at < 4_000) push(Math.min(500, 4_000 - at));
  while (at < expectedEnd - 300) push(Math.min(500, expectedEnd - 300 - at));
  while (at < expectedEnd + REVEAL_DELAY + 200) push(FRAME);
  while (at < 11_000) push(500);
  return steps;
};

const run = (startedAt: number, clockStep: number, expectedEnd: number, probe: Probe): Moments => {
  const moments: Partial<Moments> = {};
  let lastRotation = rotation();
  let lastMove = 0;
  let at = 0;
  for (const step of stepsUntil(expectedEnd)) {
    if (at === 4_000) vi.setSystemTime(Date.now() + clockStep);
    act(() => {
      vi.advanceTimersByTime(step);
    });
    at += step;
    const now = performance.now() - startedAt;
    const current = rotation();
    if (current !== lastRotation) lastMove = now;
    lastRotation = current;
    for (const key of ["revealed", "editsOpen", "guardOpen"] as const) {
      if (moments[key] === undefined && probe(key)) moments[key] = now;
    }
  }
  moments.dialStopped = lastMove;
  return moments as Moments;
};

const expectOneMoment = (moments: Moments, expectedEnd: number) => {
  expect(moments.dialStopped).toBeGreaterThanOrEqual(expectedEnd - FRAME);
  expect(moments.dialStopped).toBeLessThanOrEqual(expectedEnd + 2 * FRAME);
  expect(Math.abs(moments.editsOpen - moments.dialStopped)).toBeLessThanOrEqual(2 * FRAME);
  expect(Math.abs(moments.guardOpen - moments.dialStopped)).toBeLessThanOrEqual(2 * FRAME);
  expect(moments.revealed - moments.dialStopped).toBeGreaterThanOrEqual(0);
  expect(moments.revealed - moments.dialStopped).toBeLessThanOrEqual(REVEAL_DELAY + 2 * FRAME);
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.setSystemTime(1_800_000_000_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON() {} }) as DOMRect
  );
  harness.doc = new Y.Doc();
  addEntries(harness.doc, ["Cy", "Ada", "Bo"]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one spin timeline when the device clock moves mid-spin", () => {
  it.each([
    [-10_000, 0],
    [10_000, 0],
    [0, 750],
  ])("web: the dial stops, the result shows and edits reopen together (clock step %d ms, receiver %d ms fast)", (clockStep, receiverAhead) => {
    act(() => root.render(<WheelWebApp />));
    const startedAt = startRemoteSpin(receiverAhead);
    const expectedEnd = DURATION - receiverAhead;
    const moments = run(startedAt, clockStep, expectedEnd, (key) => {
      if (key === "revealed") return Array.from(container.querySelectorAll("p, span, div:not(:has(*))")).some((node) => node.textContent === "Spun by Grace");
      if (key === "editsOpen") return container.querySelector<HTMLButtonElement>('[data-wheel-action="sort"]')?.disabled === false;
      act(() => harness.panel!.onSort());
      return getEntries(harness.doc)[0].label === "Ada";
    });
    expectOneMoment(moments, expectedEnd);
  });

  it.each([
    [-10_000, 0, false],
    [10_000, 0, false],
    [0, 750, false],
    [-10_000, 0, true],
    [10_000, 0, true],
    [0, 750, true],
  ])("native: the dial stops, the result shows and edits reopen together (clock step %d ms, receiver %d ms fast, Reduce Motion %s)", (clockStep, receiverAhead, reduceMotion) => {
    const posted: { type: string; payload: Record<string, unknown> }[] = [];
    const session = new NativeEmbedSession(
      { platform: "ios", post: (message: string) => posted.push(JSON.parse(message)), onMessage: () => {} },
      SCOPE,
      harness.doc
    );
    act(() => root.render(<NativeWheelEmbed session={session} />));
    act(() => {
      session.receive(
        encodeEnvelope("status", SCOPE, "h-1", { readOnly: false, connection: "live", reduceMotion, pencilOnly: false, userId: "me", userName: "Me" })
      );
      session.receive(encodeEnvelope("snapshot", SCOPE, "h-2", { syncMessage: "", awarenessUpdate: "", stateVector: "" }));
    });
    const startedAt = startRemoteSpin(receiverAhead);
    const expectedEnd = DURATION - receiverAhead;
    const spinning = () =>
      ([...posted].reverse().find((message) => message.type === "status")?.payload.app as { spinning: boolean } | undefined)?.spinning;
    let probe = 10;
    const guardOpen = () => {
      probe += 1;
      const requestId = `h-${probe}`;
      act(() => {
        session.receive(encodeEnvelope("removeEntry", SCOPE, requestId, { entryId: "missing" }));
      });
      const ack = posted.find((message) => message.type === "ack" && (message as { requestId?: string }).requestId === requestId);
      return ack?.payload.ok === true;
    };
    const moments = run(startedAt, clockStep, expectedEnd, (key) => {
      if (key === "revealed") return container.querySelector(".wheel-winner") !== null;
      if (key === "editsOpen") return spinning() === false;
      return guardOpen();
    });
    expectOneMoment(moments, expectedEnd);
  });
});
