// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, getSpin, removeEntryById, startSpin, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
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
const SENT_AT = START - 5_000;
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
    | { spinning: boolean; winnerLabel: string; waiting: number; entries: { id: string; label: string }[] }
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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

    advance(DURATION);
    act(() => stage().onSpinningChange(false));
    act(() => stage().onSettled(stage().spin ?? stored, true));
    advance(5_000);
    expect(slices()).toEqual(["Ada", "Bo", ""]);
    expect(lastStatus()?.winnerLabel).toBe("3");
    const overlay = container.querySelector<HTMLElement>(".wheel-winner");
    expect(overlay?.textContent).toBe("3");

    act(() => overlay!.click());
    expect(slices()).toEqual(["Ada", "Bo"]);
  });

  it("numbers the dial from the names list as it is now while the result still holds the spin's slices", () => {
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    mount(false);
    const stored = spinBy(getEntries(doc), 0);
    advance(DURATION + 50);
    act(() => stage().onSpinningChange(false));
    act(() => stage().onSettled(stage().spin ?? stored, true));
    advance(5_000);
    const dial = () => stage().entries.map((entry) => entry.label);
    const list = () => stage().listEntries.map((entry) => entry.label);
    expect([dial(), list()]).toEqual([["Cy", "Ada", "Bo"], ["Cy", "Ada", "Bo"]]);

    expect(ackFor(deliver("sort", {}))).toEqual({ ok: true });
    expect(ackFor(deliver("removeEntry", { entryId: getEntries(doc)[1].id }))).toEqual({ ok: true });
    expect([dial(), list()]).toEqual([["Cy", "Ada", "Bo"], ["Ada", "Cy"]]);
    expect(lastStatus()?.entries.map((entry) => entry.label)).toEqual(["Ada", "Cy"]);

    act(() => container.querySelector<HTMLElement>(".wheel-winner")!.click());
    expect([dial(), list()]).toEqual([["Ada", "Cy"], ["Ada", "Cy"]]);
  });

  it("spins as the person the newest host status names when that status and the spin arrive in the same task", () => {
    addEntries(doc, ["Ada", "Bo"]);
    mount(false);
    const viewer = { readOnly: true, connection: "live", reduceMotion: false, pencilOnly: false, userId: "viewer-1", userName: "Viewer" };
    deliver("status", viewer);
    act(() => {
      session.receive(encodeEnvelope("status" as never, SCOPE, "h-90", { ...viewer, readOnly: false, userId: "host-2", userName: "Grace" }));
      session.receive(encodeEnvelope("spin" as never, SCOPE, "h-91", {}));
    });
    expect(ackFor("h-91")).toEqual({ ok: true });
    expect(getSpin(doc)).toMatchObject({ spunById: "host-2", spunByName: "Grace" });
  });

  it("refuses a spin from someone the newest host status made read-only in the same task", () => {
    addEntries(doc, ["Ada", "Bo"]);
    mount(false);
    act(() => {
      session.receive(
        encodeEnvelope("status" as never, SCOPE, "h-90", { readOnly: true, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" })
      );
      session.receive(encodeEnvelope("spin" as never, SCOPE, "h-91", {}));
    });
    expect(ackFor("h-91")).toEqual({ ok: false, error: "readOnly" });
    expect(getSpin(doc)).toBeNull();
  });

  it("tells native how many accepted names wait for a place", () => {
    addEntries(doc, Array.from({ length: 63 }, (_, index) => `N${index + 1}`));
    const others = ["Late 1", "Late 2", "Late 3"].map((late) => {
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
      addEntries(other, [late]);
      return other;
    });
    for (const other of others) Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    mount(false);
    expect(lastStatus()?.entries).toHaveLength(64);
    expect(lastStatus()?.waiting).toBe(2);
    expect(ackFor(deliver("removeEntry", { entryId: getEntries(doc)[0].id }))).toEqual({ ok: true });
    expect(lastStatus()?.entries).toHaveLength(64);
    expect(lastStatus()?.waiting).toBe(1);
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

  it("keeps a finished spin finished when the device clock steps back, so status and the command guard agree", () => {
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    mount(false);
    spinBy(getEntries(doc), 0);
    advance(DURATION + 50);
    act(() => {
      vi.setSystemTime(Date.now() - 10_000);
    });
    advance(10);
    expect(lastStatus()?.spinning).toBe(false);
    expect(ackFor(deliver("sort", {}))).toEqual({ ok: true });
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["Ada", "Bo", "Cy"]);
  });

  it("ends a spin on schedule when the device clock steps back mid-spin", () => {
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    mount(false);
    spinBy(getEntries(doc), 0);
    advance(DURATION / 2);
    act(() => {
      vi.setSystemTime(Date.now() - 10_000);
    });
    expect(ackFor(deliver("sort", {}))).toEqual({ ok: false, error: "spinning" });
    advance(DURATION / 2 + 50);
    expect(lastStatus()?.spinning).toBe(false);
    expect(ackFor(deliver("sort", {}))).toEqual({ ok: true });
  });
});

describe("native wheel adds across embed reloads", () => {
  type Send = (type: string, payload: Record<string, unknown>, requestId: string) => Record<string, unknown> | undefined;
  type Embed = { send: Send; raw: Send };

  const openEmbed = (appSessionId = SCOPE.appSessionId): Embed => {
    const scope = { ...SCOPE, appSessionId };
    const sent: { type: string; requestId: string; payload: Record<string, unknown> }[] = [];
    const embed = new NativeEmbedSession({ platform: "ios", post: (message: string) => sent.push(JSON.parse(message)), onMessage: () => {} }, scope, doc);
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<NativeWheelEmbed session={embed} />));
    const raw: Send = (type, payload, requestId) => {
      embed.receive(encodeEnvelope(type as never, scope, requestId, payload));
      return sent.find((message) => message.type === "ack" && message.requestId === requestId)?.payload;
    };
    const send: Send = (type, payload, requestId) => {
      let answer: Record<string, unknown> | undefined;
      act(() => {
        answer = raw(type, payload, requestId);
      });
      return answer;
    };
    send("status", { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "boot-status");
    send("snapshot", { syncMessage: "", awarenessUpdate: "", stateVector: "" }, "boot-snapshot");
    return { send, raw };
  };

  const names = () => getEntries(doc).map((entry) => entry.label);

  it("adds a name once when the same add reaches a reloaded embed again", () => {
    const first = openEmbed();
    const add = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };
    expect(first.send("addEntries", add, "h-1")).toEqual({ ok: true, added: [0] });
    const reloaded = openEmbed();
    expect(reloaded.send("addEntries", add, "h-1")).toEqual({ ok: true, added: [0] });
    expect(names()).toEqual(["Ada"]);
  });

  it("tells native whether an add was applied, from the document, in any embed", () => {
    const first = openEmbed();
    const tokens = ["t-blank", "t-ada", "t-bo"];
    first.send("addEntries", { labels: ["", "Ada", "Bo"], tokens, sentAt: SENT_AT }, "h-1");
    const reloaded = openEmbed();
    expect(reloaded.send("addOutcome", { tokens, sentAt: SENT_AT }, "h-2")).toEqual({ ok: true, added: [1, 2] });
    expect(reloaded.send("addOutcome", { tokens: ["t-never"], sentAt: SENT_AT }, "h-3")).toEqual({ ok: false, error: "notApplied", added: [] });
    expect(names()).toEqual(["Ada", "Bo"]);
  });

  it("keeps the same request id from another native app session apart", () => {
    openEmbed("app-1111aaaa").send("addEntries", { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT }, "h-1");
    const other = openEmbed("app-2222bbbb");
    expect(other.send("addOutcome", { tokens: ["t-cy"], sentAt: SENT_AT }, "h-2")).toEqual({ ok: false, error: "notApplied", added: [] });
    expect(other.send("addEntries", { labels: ["Cy"], tokens: ["t-cy"], sentAt: SENT_AT }, "h-1")).toEqual({ ok: true, added: [0] });
    expect(names()).toEqual(["Ada", "Cy"]);
  });

  it("takes an add in the same turn as the host status that unlocked it", () => {
    const embed = openEmbed();
    embed.send("status", { readOnly: true, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "lock");
    const refused = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };
    expect(embed.send("addEntries", refused, "h-1")).toEqual({ ok: false, error: "readOnly", added: [] });
    expect(embed.send("addOutcome", { tokens: refused.tokens, sentAt: refused.sentAt }, "h-2")).toEqual({ ok: false, error: "notApplied", added: [] });
    const answers: (Record<string, unknown> | undefined)[] = [];
    act(() => {
      embed.raw("status", { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "unlock");
      answers.push(embed.raw("addEntries", { labels: ["Bo"], tokens: ["t-bo"], sentAt: SENT_AT }, "h-3"));
    });
    expect(answers).toEqual([{ ok: true, added: [0] }]);
    expect(names()).toEqual(["Bo"]);
  });
});

