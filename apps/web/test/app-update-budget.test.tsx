// @vitest-environment happy-dom
import { act, useContext, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useApps } from "../../../packages/apps-sdk/src/sdk/hooks/useApps";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
import { APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOADS_PER_SECOND } from "../../../packages/apps-sdk/src/sdk/limits";
import { createUploadQueue } from "../../../packages/apps-sdk/src/sdk/runtime/uploadQueue";
import { splitUpdate } from "../../../packages/apps-sdk/src/sdk/runtime/splitUpdate";
import { whiteboardApp } from "../../../packages/apps-sdk/src/apps/whiteboard/web/index";
import {
  addElement,
  createWhiteboardDoc,
  ensureDefaultPage,
  getActivePageId,
  getPageElements,
  updateElement,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import { wheelApp } from "../../../packages/apps-sdk/src/apps/wheel/web/index";
import { addItem, getItems, getNotes, setNotes } from "../../../packages/apps-sdk/src/apps/dev-playground/core/doc/index";
import { addEntry, createWheelDoc, getEntries, getHistory, startSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import { useSyncedPlayback } from "../../../packages/apps-sdk/src/apps/watch/web/hooks/useSyncedPlayback";
import { createWatchDoc, getPlayback, getVideoId, setVideo } from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";
import { RATE_LIMITS, takeToken } from "../../../packages/sfu/server/socket/rateLimit";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

let root: Root;
let container: HTMLDivElement;
let ctx: AppsContextValue;

const budgetedSfu = (appId: string, serverDoc: Y.Doc) => {
  const limiter = {} as never;
  const listeners = new Map<string, Set<Listener>>();
  const sentAt: number[] = [];
  const sentBytes: number[] = [];
  const reasons: string[] = [];
  const partsSeen: Array<{ id: string; index: number; count: number }> = [];
  let staged: { id: string; parts: Uint8Array[] } | null = null;
  const state = {
    refusals: 0,
    refuseNext: null as null | ((after: Y.Doc) => boolean),
    refusalReason: "timed-out",
    refusalsLeft: 1,
    refusalDelayMs: 0,
    syncDelayMs: 0,
    stagesParts: false,
    docLimit: Number.POSITIVE_INFINITY,
    refusedReplicas: new Set<string>(),
  };
  const refuse = (replicaId: string, reason: string, delayMs = 0) => {
    state.refusals += 1;
    reasons.push(reason);
    state.refusedReplicas.add(replicaId);
    staged = null;
    setTimeout(() => fire("apps:yjs:refused", { appId, replicaId, reason }), delayMs);
  };
  const accept = (replicaId: string, updates: Uint8Array[]) => {
    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(serverDoc));
    updates.forEach((update) => Y.applyUpdate(after, update));
    const refusedByTest = state.refuseNext?.(after) ?? false;
    if (refusedByTest) {
      if (--state.refusalsLeft === 0) state.refuseNext = null;
      refuse(replicaId, state.refusalReason, state.refusalDelayMs);
      return;
    }
    if (after.store.pendingStructs !== null || after.store.pendingDs !== null) {
      refuse(replicaId, "missing-dependency");
      return;
    }
    if (Y.encodeStateAsUpdate(after).length > state.docLimit) {
      refuse(replicaId, "too-large");
      return;
    }
    updates.forEach((update) => Y.applyUpdate(serverDoc, update));
  };
  const fire = (event: string, payload: unknown) => listeners.get(event)?.forEach((listener) => listener(payload));
  const socket = {
    connected: true,
    on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    emit: (event: string, payload?: unknown, ack?: Ack) => {
      if (event === "apps:getState" && typeof payload === "function") {
        (payload as Ack)({ activeAppId: appId, locked: false });
        return;
      }
      if (event === "apps:yjs:sync" && typeof ack === "function") {
        const answer = () =>
          ack({
            syncMessage: Y.encodeStateAsUpdate(serverDoc),
            stateVector: Y.encodeStateVector(serverDoc),
            ...(state.stagesParts ? { stagesParts: true } : {}),
          });
        if (state.syncDelayMs > 0) setTimeout(answer, state.syncDelayMs);
        else answer();
        return;
      }
      if (event !== "apps:yjs:update") return;
      const { update, replicaId, part } = payload as { update: Uint8Array; replicaId: string; part?: { id: string; index: number; count: number } };
      sentAt.push(Date.now());
      sentBytes.push(update.length);
      if (part) partsSeen.push(part);
      if (state.refusedReplicas.has(replicaId)) return;
      if (!takeToken(limiter, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) {
        refuse(replicaId, "rate-limited");
        return;
      }
      if (update.length > APP_DOCUMENT_UPDATE_MAX_BYTES) {
        refuse(replicaId, "too-large");
        return;
      }
      if (!part || !state.stagesParts) {
        staged = null;
        accept(replicaId, [update]);
        return;
      }
      if (part.index === 0) staged = { id: part.id, parts: [] };
      if (!staged || staged.id !== part.id || staged.parts.length !== part.index) {
        refuse(replicaId, "invalid");
        return;
      }
      staged.parts.push(update);
      if (staged.parts.length < part.count) return;
      const { parts } = staged;
      staged = null;
      accept(replicaId, parts);
    },
  } as unknown as Socket;
  const busiestSecond = () =>
    sentAt.reduce((most, start, index) => Math.max(most, sentAt.slice(index).filter((time) => time < start + 1_000).length), 0);
  return { socket, state, sentAt, sentBytes, reasons, partsSeen, busiestSecond, fire };
};

const mount = async (socket: Socket, Body: ComponentType, apps: never[]) => {
  function Probe() {
    ctx = useContext(AppsContext)!;
    return ctx.state.activeAppId ? <Body /> : null;
  }
  await act(async () =>
    root.render(
      <AppsProvider socket={socket} apps={apps} user={{ id: "me", name: "Me" }} isAdmin>
        <Probe />
      </AppsProvider>,
    ),
  );
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"],
  });
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

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pressure: 0.5, button: 0, buttons: type === "pointerup" ? 0 : 1 });

const strokes = (doc: Y.Doc) =>
  getPageElements(doc, getActivePageId(doc)!)
    .filter((element) => "points" in element)
    .map((element) => JSON.stringify((element as unknown as { points: unknown[] }).points));

describe("app updates stay inside the server's budget", () => {
  it("paces uploads below the rate the server refills, from the same budget the server enforces", () => {
    expect(APP_DOCUMENT_UPLOADS_PER_SECOND).toBeLessThan(RATE_LIMITS.appsYjsUpdate.refillPerSec);
    expect(APP_DOCUMENT_UPLOADS_PER_SECOND).toBeGreaterThan(0);
  });

  it("lets a five second freehand stroke at 120 Hz through the real limiter with nothing refused and the stroke intact", async () => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    await mount(sfu.socket, whiteboardApp.web!, [whiteboardApp as never]);
    const canvas = [...container.querySelectorAll("canvas")].find((candidate) => candidate.onpointerdown !== undefined)!;
    canvas.setPointerCapture ??= () => undefined;
    canvas.releasePointerCapture ??= () => undefined;

    await act(async () => canvas.dispatchEvent(pointer("pointerdown", 20, 20)));
    for (let step = 1; step <= 600; step += 1) {
      await advance(8);
      await act(async () => canvas.dispatchEvent(pointer("pointermove", 20 + step * 0.5, 20 + Math.sin(step / 20) * 40)));
    }
    await act(async () => canvas.dispatchEvent(pointer("pointerup", 320, 20)));
    await advance(2_000);

    expect(sfu.state.refusals).toBe(0);
    expect(ctx.isRebuilding).toBe(false);
    const drawn = strokes(ctx.getDoc("whiteboard"));
    expect(drawn).toHaveLength(1);
    expect(JSON.parse(drawn[0]).length).toBeGreaterThan(250);
    expect(strokes(server)).toEqual(drawn);
    expect(sfu.busiestSecond()).toBeLessThanOrEqual(APP_DOCUMENT_UPLOADS_PER_SECOND);
  });

  it("sends a whiteboard element replacement as a single update", () => {
    const doc = createWhiteboardDoc();
    ensureDefaultPage(doc);
    const pageId = getActivePageId(doc)!;
    const element = { id: "stroke", type: "pen", points: [{ x: 0, y: 0 }], color: "#fff", width: 2 } as never;
    addElement(doc, pageId, element);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));

    updateElement(doc, pageId, { ...(element as object), points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] } as never);

    expect(updates).toHaveLength(1);
  });

  it("keeps a wheel's rapid edits and a spin inside the budget", async () => {
    const server = createWheelDoc();
    const sfu = budgetedSfu("wheel", server);
    await mount(sfu.socket, wheelApp.web!, [wheelApp as never]);

    for (let index = 0; index < 40; index += 1) {
      await act(async () => addEntry(ctx.getDoc("wheel"), `Name ${index}`));
      await advance(20);
    }
    await act(async () =>
      startSpin(ctx.getDoc("wheel"), {
        spinId: "budget-spin",
        entries: getEntries(ctx.getDoc("wheel")),
        winnerIndex: 3,
        startedAt: Date.now(),
        durationMs: 1_000,
        turns: 2,
        jitter: 0.5,
        spunById: "me",
        spunByName: "Me",
      }),
    );
    await advance(5_000);

    expect(sfu.state.refusals).toBe(0);
    expect(getEntries(server)).toHaveLength(40);
    expect(getHistory(server).map((result) => result.spinId)).toEqual(["budget-spin"]);
    expect(sfu.busiestSecond()).toBeLessThanOrEqual(APP_DOCUMENT_UPLOADS_PER_SECOND);
  });

  it("keeps five seconds of watch scrubbing inside the budget and lands on the last position", async () => {
    const server = createWatchDoc();
    setVideo(server, "clip", { play: true });
    const sfu = budgetedSfu("watch", server);
    let seek: (seconds: number) => void = () => undefined;
    function Scrubber() {
      const { documents } = useApps();
      const { doc } = useAppDoc("watch");
      const player = useSyncedPlayback({
        doc,
        videoId: getVideoId(doc),
        readOnly: false,
        writeOnce: (key, write) => documents.writeOnce("watch", key, write),
      });
      seek = player.seek;
      return null;
    }
    await mount(sfu.socket, Scrubber, [{ id: "watch", name: "Watch" } as never]);

    for (let step = 1; step <= 500; step += 1) {
      await act(async () => seek(step / 10));
      await advance(10);
    }
    await advance(2_000);

    expect(sfu.state.refusals).toBe(0);
    expect(getPlayback(server).positionSeconds).toBeCloseTo(50, 1);
    expect(sfu.busiestSecond()).toBeLessThanOrEqual(APP_DOCUMENT_UPLOADS_PER_SECOND);
  });

  const refuseTheFirstOfTwoShapes = async (reason: string) => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    await mount(sfu.socket, () => null, [whiteboardApp as never]);
    const pageId = getActivePageId(ctx.getDoc("whiteboard"))!;
    sfu.state.refuseNext = (after) => getPageElements(after, pageId).some((element) => element.id === "refused");
    sfu.state.refusalReason = reason;
    sfu.state.refusalDelayMs = 20;
    const live = ctx.getDoc("whiteboard");

    await act(async () => {
      addElement(live, pageId, { id: "refused", type: "rect", x: 0, y: 0, width: 5, height: 5 } as never);
    });
    await advance(10);
    await act(async () => {
      addElement(live, pageId, { id: "unsent", type: "rect", x: 10, y: 10, width: 5, height: 5 } as never);
    });
    const sentBeforeRefusal = sfu.sentAt.length;
    await advance(2_000);
    return { sfu, server, pageId, live, sentBeforeRefusal };
  };

  it("keeps the refused change and the one it had not sent yet when the refusal is a passing one", async () => {
    const { sfu, server, pageId, live, sentBeforeRefusal } = await refuseTheFirstOfTwoShapes("timed-out");

    expect(sentBeforeRefusal).toBe(1);
    expect(sfu.sentAt).toHaveLength(2);
    expect(sfu.state.refusals).toBe(1);
    expect(ctx.getDoc("whiteboard")).toBe(live);
    expect(ctx.isRebuilding).toBe(false);
    expect(ctx.rejectedChangeAt).toBeNull();
    expect(getPageElements(server, pageId).map((element) => element.id).sort()).toEqual(["refused", "unsent"]);
    expect(getPageElements(live, pageId).map((element) => element.id).sort()).toEqual(["refused", "unsent"]);
  });

  it("sends a change made while it resends after a passing refusal along with the resend", async () => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    await mount(sfu.socket, () => null, [whiteboardApp as never]);
    const pageId = getActivePageId(ctx.getDoc("whiteboard"))!;
    const live = ctx.getDoc("whiteboard");
    sfu.state.refuseNext = (after) => getPageElements(after, pageId).some((element) => element.id === "refused");
    sfu.state.syncDelayMs = 200;

    await act(async () => {
      addElement(live, pageId, { id: "refused", type: "rect", x: 0, y: 0, width: 5, height: 5 } as never);
    });
    await advance(100);
    await act(async () => {
      addElement(live, pageId, { id: "during", type: "rect", x: 10, y: 10, width: 5, height: 5 } as never);
    });
    await advance(2_000);

    expect(sfu.state.refusals).toBe(1);
    expect(getPageElements(server, pageId).map((element) => element.id).sort()).toEqual(["during", "refused"]);
  });

  const pileUpDuringResend = async (stagesParts: boolean) => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    sfu.state.stagesParts = stagesParts;
    await mount(sfu.socket, () => null, [whiteboardApp as never]);
    const pageId = getActivePageId(ctx.getDoc("whiteboard"))!;
    const live = ctx.getDoc("whiteboard");
    sfu.state.refuseNext = (after) => getPageElements(after, pageId).some((element) => element.id === "refused");
    sfu.state.syncDelayMs = 1_000;

    await act(async () => {
      addElement(live, pageId, { id: "refused", type: "rect", x: 0, y: 0, width: 5, height: 5 } as never);
    });
    await advance(100);
    for (let index = 0; index < 40; index += 1) {
      await act(async () => {
        addElement(live, pageId, { id: `note-${index}`, type: "text", x: index, y: 0, text: `${index}`.padEnd(10_000, "x"), color: "#fff", fontSize: 16 } as never);
      });
      await advance(10);
    }
    await advance(5_000);
    return { sfu, server, pageId, live };
  };

  it("sends a resend bigger than one update as numbered parts of one change to a server that stages them, and all of it lands", async () => {
    const { sfu, server, pageId, live } = await pileUpDuringResend(true);

    expect(sfu.reasons).toEqual(["timed-out"]);
    expect(Math.max(...sfu.sentBytes)).toBeLessThanOrEqual(APP_DOCUMENT_UPDATE_MAX_BYTES);
    expect(sfu.partsSeen.length).toBeGreaterThan(1);
    expect(new Set(sfu.partsSeen.map((part) => part.id)).size).toBe(1);
    expect(sfu.partsSeen.map((part) => part.index)).toEqual(sfu.partsSeen.map((_, index) => index));
    expect(ctx.getDoc("whiteboard")).toBe(live);
    expect(getPageElements(server, pageId)).toHaveLength(41);
  });

  it("sends a resend bigger than one update whole to a server that does not stage parts, so none of it is saved in part", async () => {
    const { sfu, server, pageId } = await pileUpDuringResend(false);

    expect(sfu.partsSeen).toEqual([]);
    expect(sfu.reasons).toEqual(["timed-out", "too-large"]);
    expect(getPageElements(server, pageId)).toEqual([]);
    expect(ctx.rejectedChangeReason).toBe("too-large");
  });

  const nearTheDocumentLimit = async (pasted: number) => {
    const server = new Y.Doc();
    for (let index = 0; index < 3; index += 1) addItem(server, `${index}`.padEnd(220 * 1024, "i"));
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    sfu.state.docLimit = 1024 * 1024;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const paste = "p".repeat(pasted);

    await act(async () => setNotes(ctx.getDoc("dev-playground"), paste));
    await advance(2_000);
    return { sfu, server, paste };
  };

  it("saves none of a large paste that would push the document past its limit, never part of it", async () => {
    const { sfu, server } = await nearTheDocumentLimit(400 * 1024);

    expect(sfu.partsSeen.length).toBeGreaterThan(1);
    expect(sfu.reasons).toEqual(["too-large"]);
    expect(getNotes(server)).toBe("");
    expect(getNotes(ctx.getDoc("dev-playground"))).toBe("");
    expect(ctx.rejectedChangeReason).toBe("too-large");
  });

  it("saves all of a large paste that fits under the document limit", async () => {
    const { sfu, server, paste } = await nearTheDocumentLimit(300 * 1024);

    expect(sfu.partsSeen.length).toBeGreaterThan(1);
    expect(sfu.reasons).toEqual([]);
    expect(getNotes(server)).toBe(paste);
  });

  it("stops sending parts once it moves to a server that has not offered to stage them", async () => {
    const staging = budgetedSfu("dev-playground", new Y.Doc());
    staging.state.stagesParts = true;
    await mount(staging.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    await act(async () => setNotes(ctx.getDoc("dev-playground"), "s".repeat(300 * 1024)));
    await advance(1_000);
    expect(staging.partsSeen.length).toBeGreaterThan(1);

    const older = budgetedSfu("dev-playground", new Y.Doc());
    older.state.syncDelayMs = 5_000;
    await mount(older.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    await act(async () => setNotes(ctx.getDoc("dev-playground"), "o".repeat(300 * 1024)));
    await advance(6_000);

    expect(older.partsSeen).toEqual([]);
  });

  const catchUpWithThreeChanges = async (docLimit: number) => {
    const server = new Y.Doc();
    addItem(server, "already saved");
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    sfu.state.docLimit = docLimit;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    sfu.state.refuseNext = (after) => getItems(after).includes("refused once");
    sfu.state.syncDelayMs = 500;
    const paste = "n".repeat(300 * 1024);

    await act(async () => addItem(live, "refused once"));
    await advance(100);
    await act(async () => addItem(live, "first"));
    await act(async () => setNotes(live, paste));
    await act(async () => addItem(live, "last"));
    await advance(3_000);
    return { sfu, server, paste };
  };

  it("keeps every change in a large resend whole: all of them land when they fit", async () => {
    const { sfu, server, paste } = await catchUpWithThreeChanges(Number.POSITIVE_INFINITY);

    expect(sfu.reasons).toEqual(["timed-out"]);
    expect(sfu.partsSeen.length).toBeGreaterThan(1);
    expect(getItems(server)).toEqual(["already saved", "refused once", "first", "last"]);
    expect(getNotes(server)).toBe(paste);
  });

  it("keeps every change in a large resend whole: none of them land in part when one would pass the document limit", async () => {
    const { sfu, server } = await catchUpWithThreeChanges(200 * 1024);

    expect(sfu.reasons).toEqual(["timed-out", "too-large"]);
    expect(getItems(server)).toEqual(["already saved"]);
    expect(getNotes(server)).toBe("");
    expect(getItems(ctx.getDoc("dev-playground"))).toEqual(["already saved"]);
  });

  it("holds its changes while the socket is down and sends them as one upload when it connects", async () => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    await mount(sfu.socket, () => null, [whiteboardApp as never]);
    const pageId = getActivePageId(ctx.getDoc("whiteboard"))!;
    const socket = sfu.socket as unknown as { connected: boolean };
    socket.connected = false;
    const sentBefore = sfu.sentAt.length;

    for (let index = 0; index < 30; index += 1) {
      await act(async () => {
        addElement(ctx.getDoc("whiteboard"), pageId, { id: `offline-${index}`, type: "rect", x: index, y: 0, width: 5, height: 5 } as never);
      });
      await advance(20);
    }
    expect(sfu.sentAt.length).toBe(sentBefore);
    socket.connected = true;
    await act(async () => sfu.fire("connect", undefined));
    await advance(1_000);

    expect(sfu.sentAt.length).toBe(sentBefore + 1);
    expect(sfu.state.refusals).toBe(0);
    expect(getPageElements(server, pageId)).toHaveLength(30);
  });

  it("falls back to the server's copy after three passing refusals in a row", async () => {
    const server = createWhiteboardDoc();
    ensureDefaultPage(server);
    const sfu = budgetedSfu("whiteboard", server);
    await mount(sfu.socket, () => null, [whiteboardApp as never]);
    const pageId = getActivePageId(ctx.getDoc("whiteboard"))!;
    const live = ctx.getDoc("whiteboard");
    const doomed = (after: Y.Doc) => getPageElements(after, pageId).some((element) => element.id === "doomed");

    sfu.state.refuseNext = doomed;
    sfu.state.refusalsLeft = 4;

    await act(async () => {
      addElement(live, pageId, { id: "doomed", type: "rect", x: 0, y: 0, width: 5, height: 5 } as never);
    });
    await advance(5_000);

    expect(sfu.state.refusals).toBe(4);
    expect(ctx.getDoc("whiteboard")).not.toBe(live);
    expect(getPageElements(ctx.getDoc("whiteboard"), pageId)).toEqual([]);
    expect(ctx.rejectedChangeReason).toBe("timed-out");
  });

});

describe("the upload queue", () => {
  const bigUpdate = (doc: Y.Doc, bytes: number) => {
    let captured: Uint8Array | null = null;
    const capture = (update: Uint8Array) => {
      captured = update;
    };
    doc.on("update", capture);
    doc.getText("t").insert(0, "x".repeat(bytes));
    doc.off("update", capture);
    return captured!;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("merges what waits into one upload but never past the size the server takes", async () => {
    const doc = new Y.Doc();
    const sent: Uint8Array[] = [];
    const queue = createUploadQueue((_appId, _replicaId, update) => {
      sent.push(update);
      return true;
    });
    const half = Math.floor(APP_DOCUMENT_UPDATE_MAX_BYTES * 0.6);

    queue.add("board", "r", bigUpdate(doc, 10));
    await vi.advanceTimersByTimeAsync(0);
    queue.add("board", "r", bigUpdate(doc, half));
    queue.add("board", "r", bigUpdate(doc, half));
    queue.add("board", "r", bigUpdate(doc, 10));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(3);
    expect(sent.every((update) => update.length <= APP_DOCUMENT_UPDATE_MAX_BYTES)).toBe(true);
    const rebuilt = new Y.Doc();
    sent.forEach((update) => Y.applyUpdate(rebuilt, update));
    expect(rebuilt.getText("t").toString()).toBe(doc.getText("t").toString());
  });
});

describe("splitting an update", () => {
  const MAX = APP_DOCUMENT_UPDATE_MAX_BYTES;

  const editedCopy = () => {
    const server = new Y.Doc();
    server.getArray<string>("list").push(["kept", "dropped"]);
    server.getMap("meta").set("title", "draft");
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    for (let index = 0; index < 120; index += 1) {
      client.transact(() => {
        client.getArray<string>("list").push([`${index}`.padEnd(5_000, "y")]);
        client.getMap("meta").set("title", `draft ${index}`);
      });
    }
    client.getText("notes").insert(0, "notes");
    client.getArray<string>("list").delete(1, 1);
    client.getArray<string>("list").delete(4, 3);
    return { server, client, missing: Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)) };
  };

  it("cuts what the server lacks into pieces under the cap that each apply in order", () => {
    const { server, client, missing } = editedCopy();
    expect(missing.length).toBeGreaterThan(2 * MAX);

    const pieces = splitUpdate(missing, MAX);

    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.length <= MAX)).toBe(true);
    for (const piece of pieces) {
      Y.applyUpdate(server, piece);
      expect(server.store.pendingStructs).toBeNull();
      expect(server.store.pendingDs).toBeNull();
    }
    expect(server.getArray("list").toJSON()).toEqual(client.getArray("list").toJSON());
    expect(server.getMap("meta").toJSON()).toEqual(client.getMap("meta").toJSON());
    expect(server.getText("notes").toString()).toBe("notes");
    expect(Y.encodeStateVector(server)).toEqual(Y.encodeStateVector(client));
  });

  it("cuts inside one long insert, keeping every character whole", () => {
    const doc = new Y.Doc();
    const text = "a\u{1F600}b".repeat(Math.ceil(MAX / 2));
    doc.getText("t").insert(0, text);
    doc.getArray("list").push(Array.from({ length: 60 }, (_, index) => `${index}`.padEnd(8_000, "q")));
    const whole = Y.encodeStateAsUpdate(doc);

    const pieces = splitUpdate(whole, MAX);
    const rebuilt = new Y.Doc();
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX);
      Y.applyUpdate(rebuilt, piece);
      expect(rebuilt.store.pendingStructs).toBeNull();
    }

    expect(pieces.length).toBeGreaterThan(2);
    expect(rebuilt.getText("t").toString()).toBe(text);
    expect(rebuilt.getArray("list").toJSON()).toEqual(doc.getArray("list").toJSON());
  });

  it("keeps every piece under the cap even when the cap is a few struct headers wide", () => {
    const doc = new Y.Doc();
    for (let round = 0; round < 12; round += 1) {
      doc.transact(() => {
        doc.getText("t").insert(doc.getText("t").length, `round ${round} `.repeat(4));
        doc.getMap("m").set(`k${round}`, round);
        doc.getArray<string>("a").push([`a${round}`, `b${round}`]);
      });
    }
    doc.getText("t").delete(3, 20);
    doc.getArray("a").delete(2, 4);
    const whole = Y.encodeStateAsUpdate(doc);

    for (let cap = 100; cap < 1_200; cap += 7) {
      const pieces = splitUpdate(whole, cap);
      const rebuilt = new Y.Doc();
      pieces.forEach((piece) => Y.applyUpdate(rebuilt, piece));
      expect({ cap, largest: Math.max(...pieces.map((piece) => piece.length)) <= cap }).toEqual({ cap, largest: true });
      expect(rebuilt.getText("t").toString()).toBe(doc.getText("t").toString());
      expect(rebuilt.getArray("a").toJSON()).toEqual(doc.getArray("a").toJSON());
      expect(rebuilt.getMap("m").toJSON()).toEqual(doc.getMap("m").toJSON());
    }
  });

  it("keeps a cut piece under the cap when it sits between two neighbours with large clocks", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "x".repeat(40_000));
    text.delete(0, 39_990);
    for (let round = 0; round < 40; round += 1) text.insert(5, `${round}`.padEnd(90, "m"));
    const whole = Y.encodeStateAsUpdate(doc);

    for (let cap = 100; cap < 400; cap += 1) {
      const pieces = splitUpdate(whole, cap);
      const rebuilt = new Y.Doc();
      pieces.forEach((piece) => Y.applyUpdate(rebuilt, piece));
      expect({ cap, fits: pieces.every((piece) => piece.length <= cap) }).toEqual({ cap, fits: true });
      expect(rebuilt.getText("t").toString()).toBe(text.toString());
    }
  });

  it("leaves an update under the cap, or one value too big to cut, whole", () => {
    const small = Y.encodeStateAsUpdate(editedCopy().server);
    expect(splitUpdate(small, MAX)).toEqual([small]);
    const doc = new Y.Doc();
    doc.getArray("list").push([{ image: "z".repeat(MAX + 10) }]);
    const whole = Y.encodeStateAsUpdate(doc);

    expect(splitUpdate(whole, MAX)).toEqual([whole]);
    const unreadable = new Uint8Array(MAX + 10).fill(255);
    expect(splitUpdate(unreadable, MAX)).toEqual([unreadable]);
  });

  it("sends a change in parts on its own, never merged with the changes queued before or after it", async () => {
    const { missing } = editedCopy();
    const before = new Y.Doc();
    const small = (text: string) => {
      let captured: Uint8Array | null = null;
      const capture = (update: Uint8Array) => {
        captured = update;
      };
      before.on("update", capture);
      before.getText("t").insert(0, text);
      before.off("update", capture);
      return captured!;
    };
    const sent: Array<{ update: Uint8Array; part?: { index: number } }> = [];
    const queue = createUploadQueue(
      (_appId, _replicaId, update, part) => {
        sent.push({ update, part });
        return true;
      },
      { stagesParts: () => true },
    );
    const first = small("before");
    const last = small("after");

    queue.add("board", "r", first);
    queue.add("board", "r", missing);
    queue.add("board", "r", last);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent[0]).toEqual({ update: first, part: undefined });
    expect(sent.at(-1)).toEqual({ update: last, part: undefined });
    expect(sent.slice(1, -1).map(({ part }) => part?.index)).toEqual(sent.slice(1, -1).map((_, index) => index));
  });

  it("hands a server that stages parts a change over the cap as numbered parts of one change, and any other server the whole change", async () => {
    const { missing } = editedCopy();
    const sent: Array<{ update: Uint8Array; part?: { id: string; index: number; count: number } }> = [];
    let stages = true;
    const queue = createUploadQueue(
      (_appId, _replicaId, update, part) => {
        sent.push({ update, part });
        return true;
      },
      { stagesParts: () => stages },
    );

    queue.add("board", "r", missing);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every(({ update }) => update.length <= MAX)).toBe(true);
    expect(sent.map(({ part }) => part?.index)).toEqual(sent.map((_, index) => index));
    expect(new Set(sent.map(({ part }) => `${part?.id}/${part?.count}`))).toEqual(new Set([`${sent[0].part?.id}/${sent.length}`]));
    expect(Y.encodeStateVectorFromUpdate(Y.mergeUpdates(sent.map(({ update }) => update)))).toEqual(Y.encodeStateVectorFromUpdate(missing));

    sent.length = 0;
    stages = false;
    queue.add("board", "r", missing);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ update: missing, part: undefined }]);
  });
});
