// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, removeEntryById, startSpin, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import type { WheelStage as RealWheelStage } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage";
import { encodeEnvelope } from "../../../packages/apps-sdk/src/native-embed/protocol";
import { NativeEmbedSession } from "../../../packages/apps-sdk/src/native-embed/session";

type StageProps = ComponentProps<typeof RealWheelStage>;

const harness = vi.hoisted(() => ({ stage: null as StageProps | null, dials: [] as string[][] }));

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage", () => ({
  WheelStage: (props: StageProps) => {
    harness.stage = props;
    harness.dials.push(props.entries.map((entry) => entry.label));
    return null;
  },
}));

const { NativeWheelEmbed } = await import("../../../packages/apps-sdk/src/native-embed/wheel/NativeWheelEmbed");

const SCOPE = { callSessionId: "call-9-5e1c7a2b", appSessionId: "app-3d9f1b6c", appId: "wheel" };
const START = 1_800_000_000_000;
const DURATION = 8_000;

let root: Root;
let container: HTMLDivElement;
let doc: Y.Doc;
let session: NativeEmbedSession;
let posted: { type: string; requestId: string; payload: Record<string, unknown> }[];
let requestNumber: number;

const deliver = (type: string, payload: Record<string, unknown>): string => {
  requestNumber += 1;
  const requestId = `h-${requestNumber}`;
  act(() => {
    session.receive(encodeEnvelope(type as never, SCOPE, requestId, payload));
  });
  return requestId;
};

const ackFor = (requestId: string) => posted.find((message) => message.type === "ack" && message.requestId === requestId)?.payload;

const lastStatus = () =>
  [...posted].reverse().find((message) => message.type === "status")?.payload.app as
    | { spinning: boolean; winnerLabel: string }
    | undefined;

const stage = (): StageProps => {
  expect(harness.stage).not.toBeNull();
  return harness.stage!;
};

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const spinBy = (entries: unknown[], winnerIndex: number, spinId = "spin-remote", startedAt = Date.now()): WheelSpin => {
  const spin = {
    spinId,
    entries,
    winnerIndex,
    startedAt,
    durationMs: DURATION,
    turns: 8,
    jitter: 0.5,
    spunById: "someone-else",
    spunByName: "Grace",
  } as WheelSpin;
  act(() => startSpin(doc, spin));
  return spin;
};

const mount = (reduceMotion: boolean) => {
  posted = [];
  requestNumber = 0;
  const transport = {
    platform: "ios" as const,
    post: (message: string) => posted.push(JSON.parse(message)),
    onMessage: () => {},
  };
  session = new NativeEmbedSession(transport, SCOPE, doc);
  act(() => root.render(<NativeWheelEmbed session={session} />));
  deliver("status", { readOnly: false, connection: "live", reduceMotion, pencilOnly: false, userId: "me", userName: "Me" });
  deliver("snapshot", { syncMessage: "", awarenessUpdate: "", stateVector: "" });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.stage = null;
  harness.dials = [];
  doc = new Y.Doc();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native wheel embed while a shared spin runs", () => {
  it.each([true, false])("keeps sort, shuffle, remove and clear closed until the shared spin ends (Reduce Motion %s)", (reduceMotion) => {
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    mount(reduceMotion);
    spinBy(getEntries(doc), 1);
    act(() => stage().onSpinningChange(false));
    expect(lastStatus()?.spinning).toBe(true);
    const id = getEntries(doc)[0].id;
    const refused = [deliver("sort", {}), deliver("shuffle", {}), deliver("removeEntry", { entryId: id }), deliver("clearEntries", {})];
    expect(refused.map((requestId) => ackFor(requestId))).toEqual(Array(4).fill({ ok: false, error: "spinning" }));
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["Cy", "Ada", "Bo"]);

    advance(DURATION + 50);
    expect(lastStatus()?.spinning).toBe(false);
    expect(ackFor(deliver("sort", {}))).toEqual({ ok: true });
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["Ada", "Bo", "Cy"]);
  });

  it.each([true, false])("draws a build 63 spin's three slices through the result, and reads the same winner (Reduce Motion %s)", (reduceMotion) => {
    doc.getMap("wheel").set("entries", Y.Array.from([{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "z", label: "\u200B" }]));
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["Ada", "Bo"]);
    mount(reduceMotion);
    const stored = spinBy([{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "z", label: "\u200B" }], 2);
    const slices = () => stage().entries.map((entry) => entry.label);
    expect(slices()).toEqual(["Ada", "Bo", ""]);

    if (!reduceMotion) {
      act(() => stage().onSpinningChange(false));
      act(() => stage().onSettled(stage().spin ?? stored, true));
    }
    advance(DURATION + 5_000);
    expect(slices()).toEqual(["Ada", "Bo", ""]);
    expect(lastStatus()?.winnerLabel).toBe("3");
    const overlay = container.querySelector<HTMLElement>(".wheel-winner");
    expect(overlay?.textContent).toBe("3");

    act(() => overlay!.click());
    expect(slices()).toEqual(["Ada", "Bo"]);
  });

  it("shows the current names, never an older spin's, when a finished spin arrives while the app was suspended", () => {
    addEntries(doc, ["Ada", "Bo", "Cy"]);
    mount(false);
    spinBy(getEntries(doc), 2, "spin-a");
    expect(stage().entries.map((entry) => entry.label)).toEqual(["Ada", "Bo", "Cy"]);

    vi.setSystemTime(Date.now() + 60_000);
    harness.dials = [];
    act(() => {
      doc.transact(() => {
        removeEntryById(doc, getEntries(doc)[2].id);
        startSpin(doc, {
          spinId: "spin-b",
          entries: getEntries(doc),
          winnerIndex: 1,
          startedAt: Date.now() - 20_000,
          durationMs: DURATION,
          turns: 8,
          jitter: 0.5,
          spunById: "someone-else",
          spunByName: "Grace",
        });
      });
    });
    act(() => stage().onSettled(stage().spin!, false));
    advance(DURATION + 5_000);
    act(() => {
      addEntries(doc, ["Dee"]);
    });
    expect(harness.dials.some((labels) => labels.join() === "Ada,Bo,Cy")).toBe(false);
    expect(stage().entries.map((entry) => entry.label)).toEqual(["Ada", "Bo", "Dee"]);
    expect(lastStatus()?.spinning).toBe(false);
  });
});
