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
  const state = {
    refusals: 0,
    refuseNext: null as null | ((after: Y.Doc) => boolean),
    refusalReason: "timed-out",
    refusalsLeft: 1,
    refusalDelayMs: 0,
    syncDelayMs: 0,
    refusedReplicas: new Set<string>(),
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
        const answer = () => ack({ syncMessage: Y.encodeStateAsUpdate(serverDoc), stateVector: Y.encodeStateVector(serverDoc) });
        if (state.syncDelayMs > 0) setTimeout(answer, state.syncDelayMs);
        else answer();
        return;
      }
      if (event !== "apps:yjs:update") return;
      const { update, replicaId } = payload as { update: Uint8Array; replicaId: string };
      sentAt.push(Date.now());
      if (state.refusedReplicas.has(replicaId)) return;
      const after = new Y.Doc();
      Y.applyUpdate(after, Y.encodeStateAsUpdate(serverDoc));
      Y.applyUpdate(after, update);
      const refusedByTest = state.refuseNext?.(after) ?? false;
      const missing = after.store.pendingStructs !== null || after.store.pendingDs !== null;
      const limited = !takeToken(limiter, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate);
      if (refusedByTest || limited || missing) {
        if (refusedByTest && --state.refusalsLeft === 0) state.refuseNext = null;
        state.refusals += 1;
        state.refusedReplicas.add(replicaId);
        const reason = refusedByTest ? state.refusalReason : limited ? "rate-limited" : "missing-dependency";
        setTimeout(() => fire("apps:yjs:refused", { appId, replicaId, reason }), refusedByTest ? state.refusalDelayMs : 0);
        return;
      }
      Y.applyUpdate(serverDoc, update);
    },
  } as unknown as Socket;
  const busiestSecond = () =>
    sentAt.reduce((most, start, index) => Math.max(most, sentAt.slice(index).filter((time) => time < start + 1_000).length), 0);
  return { socket, state, sentAt, busiestSecond, fire };
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
