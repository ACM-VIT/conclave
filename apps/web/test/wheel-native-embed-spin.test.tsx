// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, getSpin, removeEntryById, startSpin, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import type { WheelStage as RealWheelStage } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage";
import { base64FromBytes, bytesFromBase64, encodeEnvelope } from "../../../packages/apps-sdk/src/native-embed/protocol";
import { NativeEmbedSession } from "../../../packages/apps-sdk/src/native-embed/session";
import { APP_DOCUMENT_UPLOAD_INTERVAL_MS } from "../../../packages/apps-sdk/src/sdk/limits";

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

const flushUploads = () => act(() => Promise.resolve());

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
    doc.getArray("wheel.entries").push([{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "z", label: "\u200B" }]);
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
  type Embed = { send: Send; raw: Send; ack: (requestId: string) => Record<string, unknown> | undefined };

  let room: Y.Doc;

  beforeEach(() => { room = new Y.Doc(); });
  afterEach(() => { room.destroy(); });

  const openEmbed = (appSessionId = SCOPE.appSessionId): Embed => {
    const scope = { ...SCOPE, appSessionId };
    const sent: { type: string; requestId: string; payload: Record<string, unknown> }[] = [];
    let incoming = 0;
    const embed = new NativeEmbedSession({
      platform: "ios",
      post: (raw) => {
        const message: (typeof sent)[number] = JSON.parse(raw);
        sent.push(message);
        if (message.type !== "update") return;
        const update = bytesFromBase64(message.payload.update, 1_000_000);
        if (!update.ok) throw new Error(update.reason);
        Y.applyUpdate(room, update.bytes);
        embed.receive(encodeEnvelope("update", scope, `room-${++incoming}`, message.payload));
      },
      onMessage: () => {},
    }, scope, new Y.Doc());
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<NativeWheelEmbed session={embed} />));
    const ack = (requestId: string) => sent.find((message) => message.type === "ack" && message.requestId === requestId)?.payload;
    const raw: Send = (type, payload, requestId) => {
      embed.receive(encodeEnvelope(type as never, scope, requestId, payload));
      return ack(requestId);
    };
    const send: Send = (type, payload, requestId) => {
      let answer: Record<string, unknown> | undefined;
      act(() => {
        answer = raw(type, payload, requestId);
      });
      return answer;
    };
    send("status", { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "boot-status");
    send("snapshot", { syncMessage: base64FromBytes(Y.encodeStateAsUpdate(room)) }, "boot-snapshot");
    return { send, raw, ack };
  };

  const names = () => getEntries(room).map((entry) => entry.label);

  it("adds a name once when the same add reaches a reloaded embed again", async () => {
    const first = openEmbed();
    const add = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };
    expect(first.send("addEntries", add, "h-1")).toBeUndefined();
    await flushUploads();
    expect(first.ack("h-1")).toEqual({ ok: true, added: [0] });
    const reloaded = openEmbed();
    expect(reloaded.send("addEntries", add, "h-1")).toEqual({ ok: true, added: [0] });
    expect(names()).toEqual(["Ada"]);
  });

  it("tells native whether an add was applied, from the document, in any embed", async () => {
    const first = openEmbed();
    const tokens = ["t-blank", "t-ada", "t-bo"];
    first.send("addEntries", { labels: ["", "Ada", "Bo"], tokens, sentAt: SENT_AT }, "h-1");
    await flushUploads();
    const reloaded = openEmbed();
    expect(reloaded.send("addOutcome", { tokens, sentAt: SENT_AT }, "h-2")).toEqual({ ok: true, added: [1, 2] });
    expect(reloaded.send("addOutcome", { tokens: ["t-never"], sentAt: SENT_AT }, "h-3")).toEqual({ ok: false, error: "notApplied", added: [] });
    expect(names()).toEqual(["Ada", "Bo"]);
  });

  it("keeps the same request id from another native app session apart", async () => {
    openEmbed("app-1111aaaa").send("addEntries", { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT }, "h-1");
    await flushUploads();
    const other = openEmbed("app-2222bbbb");
    expect(other.send("addOutcome", { tokens: ["t-cy"], sentAt: SENT_AT }, "h-2")).toEqual({ ok: false, error: "notApplied", added: [] });
    expect(other.send("addEntries", { labels: ["Cy"], tokens: ["t-cy"], sentAt: SENT_AT }, "h-1")).toBeUndefined();
    await flushUploads();
    expect(other.ack("h-1")).toEqual({ ok: true, added: [0] });
    expect(names()).toEqual(["Ada", "Cy"]);
  });

  it("takes an add in the same turn as the host status that unlocked it", async () => {
    const embed = openEmbed();
    embed.send("status", { readOnly: true, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "lock");
    const refused = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };
    expect(embed.send("addEntries", refused, "h-1")).toEqual({ ok: false, error: "readOnly", added: [] });
    expect(embed.send("addOutcome", { tokens: refused.tokens, sentAt: refused.sentAt }, "h-2")).toEqual({ ok: false, error: "notApplied", added: [] });
    act(() => {
      embed.raw("status", { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: "me", userName: "Me" }, "unlock");
      embed.raw("addEntries", { labels: ["Bo"], tokens: ["t-bo"], sentAt: SENT_AT }, "h-3");
    });
    expect(embed.ack("h-3")).toBeUndefined();
    await flushUploads();
    expect(embed.ack("h-3")).toEqual({ ok: true, added: [0] });
    expect(names()).toEqual(["Bo"]);
  });
});


describe("native add publication", () => {
  const submission = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };

  it("does not accept an add in the reconnect gap before resync", () => {
    mount(false);
    deliver("status", { readOnly: false, connection: "reconnecting" });
    const request = deliver("addEntries", submission);
    expect(ackFor(request)).toEqual({ ok: false, error: "notSynced", added: [] });
    expect(getEntries(doc)).toEqual([]);
    expect(posted.some(({ type }) => type === "update")).toBe(false);
  });

  it.each([false, true])("waits for the room to confirm a live add (tracked %s)", async (tracked) => {
    mount(false);
    const room = new Y.Doc();
    const request = deliver("addEntries", tracked ? submission : { labels: submission.labels });
    await flushUploads();
    const update = posted.find((message) => message.type === "update")?.payload.update;
    expect(typeof update).toBe("string");
    expect(ackFor(request)).toBeUndefined();
    if (tracked) {
      expect(ackFor(deliver("addOutcome", submission))).toEqual({ ok: false, error: "notSynced" });
    }
    const incoming = Uint8Array.from(atob(String(update)), (byte) => byte.charCodeAt(0));
    Y.applyUpdate(room, incoming);
    expect(getEntries(room).map(({ label }) => label)).toEqual(["Ada"]);
    deliver("update", { update });
    expect(ackFor(request)).toEqual({ ok: true, added: [0] });
    if (tracked) expect(ackFor(deliver("addOutcome", submission))).toEqual({ ok: true, added: [0] });
  });

  it("waits for the missing dependency before acknowledging a relayed add", async () => {
    mount(false);
    deliver("setRemoveWinner", { value: true });
    await flushUploads();
    const request = deliver("addEntries", submission);
    await act(() => vi.advanceTimersByTimeAsync(APP_DOCUMENT_UPLOAD_INTERVAL_MS));
    const updates = posted.filter(({ type }) => type === "update");
    expect(updates.length).toBeGreaterThan(1);

    deliver("update", updates.at(-1)!.payload);
    expect(ackFor(request)).toBeUndefined();
    expect(ackFor(deliver("addOutcome", submission))).not.toHaveProperty("added");

    for (const update of updates.slice(0, -1)) deliver("update", update.payload);
    expect(ackFor(request)).toEqual({ ok: true, added: [0] });
  });

  it("recovers an already published add from the room snapshot when the echo was lost", async () => {
    mount(false);
    const room = new Y.Doc();
    const request = deliver("addEntries", submission);
    await flushUploads();
    const update = bytesFromBase64(posted.find(({ type }) => type === "update")?.payload.update, 1_000_000);
    if (!update.ok) throw new Error(update.reason);
    Y.applyUpdate(room, update.bytes);
    expect(ackFor(request)).toBeUndefined();

    deliver("status", { readOnly: false, connection: "reconnecting" });
    deliver("status", { readOnly: false, connection: "live" });
    deliver("resync", {});
    const vector = bytesFromBase64(posted.find(({ type }) => type === "sync")?.payload.stateVector, 1_000_000);
    if (!vector.ok) throw new Error(vector.reason);
    deliver("snapshot", {
      syncMessage: base64FromBytes(Y.encodeStateAsUpdate(room, vector.bytes)),
      stateVector: base64FromBytes(Y.encodeStateVector(room)),
    });
    expect(ackFor(request)).toEqual({ ok: true, added: [0] });
    expect(ackFor(deliver("addOutcome", submission))).toEqual({ ok: true, added: [0] });
    room.destroy();
  });
});
