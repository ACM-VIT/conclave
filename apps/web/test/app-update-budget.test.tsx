// @vitest-environment happy-dom
import { act, useContext, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useApps } from "../../../packages/apps-sdk/src/sdk/hooks/useApps";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
import { APP_DOCUMENT_MAX_BYTES, APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOAD_INTERVAL_MS, APP_DOCUMENT_UPLOADS_PER_SECOND } from "../../../packages/apps-sdk/src/sdk/limits";
import { createUploadQueue } from "../../../packages/apps-sdk/src/sdk/runtime/uploadQueue";
import { savedSizeStaysUnder } from "../../../packages/apps-sdk/src/sdk/runtime/documentSize";
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

const joinBytes = (parts: Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};

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
    activeAppId: appId as string | null,
    joined: true,
    rejoinDelayMs: 0,
    refusedReplicas: new Set<string>(),
  };
  const syncPayloads: Array<{ wholeChanges?: boolean }> = [];
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
        (payload as Ack)(state.joined ? { activeAppId: state.activeAppId, locked: false } : { activeAppId: null, locked: false, notInRoom: true });
        return;
      }
      if (event === "apps:yjs:sync" && typeof ack === "function") {
        syncPayloads.push(payload as { wholeChanges?: boolean });
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
      if (!state.joined || state.refusedReplicas.has(replicaId)) return;
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
        refuse(replicaId, "interrupted");
        return;
      }
      staged.parts.push(update);
      if (staged.parts.length < part.count) return;
      const { parts } = staged;
      staged = null;
      accept(replicaId, [joinBytes(parts)]);
    },
  } as unknown as Socket;
  const busiestSecond = () =>
    sentAt.reduce((most, start, index) => Math.max(most, sentAt.slice(index).filter((time) => time < start + 1_000).length), 0);
  const interrupt = () => {
    (socket as unknown as { connected: boolean }).connected = false;
    state.joined = false;
    staged = null;
    fire("disconnect", "transport close");
  };
  const restore = () => {
    (socket as unknown as { connected: boolean }).connected = true;
    fire("connect", undefined);
    setTimeout(() => {
      state.joined = true;
      fire("apps:state", { activeAppId: state.activeAppId, locked: false });
    }, state.rejoinDelayMs);
  };
  const dropStaging = () => {
    staged = null;
  };
  return { socket, state, sentAt, sentBytes, reasons, partsSeen, syncPayloads, busiestSecond, fire, interrupt, restore, dropStaging };
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
  }, 30_000);

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

  it("sends nothing before the first sync reply, and then only what the server lacks, once", async () => {
    const server = new Y.Doc();
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    sfu.state.syncDelayMs = 1_000;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");

    await act(async () => addItem(live, "early"));
    await act(async () => setNotes(live, "n".repeat(300 * 1024)));
    await advance(500);
    expect(sfu.sentAt).toEqual([]);
    await advance(2_000);

    expect(sfu.reasons).toEqual([]);
    expect(new Set(sfu.partsSeen.map((part) => part.id)).size).toBe(1);
    expect(getItems(server)).toEqual(["early"]);
    expect(getNotes(server)).toBe(getNotes(live));
  });

  it("holds a large seeded document until the first sync says the server stages parts, then saves all of it", async () => {
    const seeded = "s".repeat(300 * 1024);
    const server = new Y.Doc();
    const sfu = budgetedSfu("seeded", server);
    sfu.state.stagesParts = true;
    sfu.state.syncDelayMs = 500;
    const seededApp = {
      id: "seeded",
      name: "Seeded",
      createDoc: () => {
        const doc = new Y.Doc();
        doc.getText("t").insert(0, seeded);
        return doc;
      },
    };
    await mount(sfu.socket, () => null, [seededApp as never]);
    await advance(2_000);

    expect(sfu.reasons).toEqual([]);
    expect(sfu.partsSeen.length).toBeGreaterThan(1);
    expect(sfu.sentBytes.every((bytes) => bytes <= APP_DOCUMENT_UPDATE_MAX_BYTES)).toBe(true);
    expect(ctx.getDoc("seeded").getText("t").toString()).toBe(seeded);
    expect(server.getText("t").toString()).toBe(seeded);
  });

  const reconnectDuringParts = async (partsBeforeDrop: number) => {
    const server = new Y.Doc();
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    const paste = "r".repeat(700 * 1024);

    await act(async () => setNotes(live, paste));
    await advance(APP_DOCUMENT_UPLOAD_INTERVAL_MS * (partsBeforeDrop - 1) + 1);
    expect(sfu.partsSeen.map((part) => part.index)).toEqual(Array.from({ length: partsBeforeDrop }, (_, index) => index));
    await act(async () => sfu.interrupt());
    await advance(1_000);
    await act(async () => sfu.restore());
    await advance(3_000);
    return { sfu, server, live, paste };
  };

  it("restarts a change in parts from a fresh sync after an in-place reconnect right after its first part", async () => {
    const { sfu, server, live, paste } = await reconnectDuringParts(1);

    expect(sfu.syncPayloads.length).toBeGreaterThan(1);
    expect(sfu.syncPayloads.every((payload) => payload.wholeChanges === true)).toBe(true);
    expect(sfu.reasons).toEqual([]);
    expect(getNotes(server)).toBe(paste);
    expect(ctx.getDoc("dev-playground")).toBe(live);
    expect(ctx.rejectedChangeAt).toBeNull();
  });

  it("restarts a change in parts from a fresh sync after an in-place reconnect after a later part", async () => {
    const { sfu, server, live, paste } = await reconnectDuringParts(2);

    expect(sfu.reasons).toEqual([]);
    expect(getNotes(server)).toBe(paste);
    expect(ctx.getDoc("dev-playground")).toBe(live);
    expect(ctx.rejectedChangeAt).toBeNull();
  });

  it("asks the server what is open after an in-place reconnect, and sends nothing into an app that closed meanwhile", async () => {
    const sfu = budgetedSfu("dev-playground", new Y.Doc());
    sfu.state.stagesParts = true;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    await act(async () => sfu.interrupt());
    await act(async () => setNotes(ctx.getDoc("dev-playground"), "written while away"));
    sfu.state.activeAppId = null;
    const sentBefore = sfu.sentAt.length;

    await act(async () => sfu.restore());
    await advance(3_000);

    expect(ctx.state.activeAppId).toBeNull();
    expect(sfu.sentAt).toHaveLength(sentBefore);
  });

  it("keeps an offline edit through an in-place reconnect whose room rejoin takes 350 ms", async () => {
    const server = new Y.Doc();
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    await act(async () => sfu.interrupt());
    await act(async () => addItem(live, "drawn offline"));
    sfu.state.rejoinDelayMs = 350;

    await act(async () => sfu.restore());
    await advance(100);
    await act(async () => {
      ctx.refreshState();
    });
    await advance(3_000);

    expect(ctx.getDoc("dev-playground")).toBe(live);
    expect(getItems(live)).toEqual(["drawn offline"]);
    expect(getItems(server)).toEqual(["drawn offline"]);
    expect(sfu.reasons).toEqual([]);
  });

  it("sends nothing between an in-place reconnect and its room rejoin, and an edit made in between lands after it", async () => {
    const server = new Y.Doc();
    addItem(server, "saved");
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    await act(async () => sfu.interrupt());
    sfu.state.rejoinDelayMs = 400;
    const sentBefore = sfu.sentAt.length;

    await act(async () => sfu.restore());
    await advance(100);
    await act(async () => addItem(live, "drawn before the rejoin"));
    await advance(250);
    expect(sfu.sentAt).toHaveLength(sentBefore);
    await advance(3_000);

    expect(ctx.getDoc("dev-playground")).toBe(live);
    expect(getItems(server)).toEqual(["saved", "drawn before the rejoin"]);
    expect(sfu.reasons).toEqual([]);
  });

  it("treats a refused part as passing: it resends the whole change from a fresh sync and keeps the local copy", async () => {
    const server = new Y.Doc();
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    const paste = "q".repeat(700 * 1024);

    await act(async () => setNotes(live, paste));
    await advance(1);
    sfu.dropStaging();
    await advance(3_000);

    expect(sfu.reasons).toEqual(["interrupted"]);
    expect(getNotes(server)).toBe(paste);
    expect(ctx.getDoc("dev-playground")).toBe(live);
    expect(ctx.rejectedChangeAt).toBeNull();
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

describe("edits near the document limit", () => {
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = (random: () => number, below: number) => Math.floor(random() * below);
  const encodedBytes = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc).length;
  const savedBytes = (doc: Y.Doc) => {
    const saved = new Y.Doc();
    Y.applyUpdate(saved, Y.encodeStateAsUpdate(doc));
    return encodedBytes(saved);
  };
  const labels = (doc: Y.Doc) => getItems(doc).map((item) => /^[a-z]+-\d+-/.exec(item)?.[0] ?? item.slice(0, 12));

  const burstNearTheLimit = async (seed: number) => {
    const random = seeded(seed);
    const server = new Y.Doc();
    const filled = APP_DOCUMENT_MAX_BYTES - 1_024 - pick(random, 420 * 1024);
    for (let index = 0; encodedBytes(server) < filled - 16; index += 1) {
      addItem(server, `saved-${index}-`.padEnd(Math.min(200 * 1024, filled - encodedBytes(server)), "s"));
    }
    const sfu = budgetedSfu("dev-playground", server);
    sfu.state.stagesParts = true;
    sfu.state.docLimit = APP_DOCUMENT_MAX_BYTES;
    await mount(sfu.socket, () => null, [{ id: "dev-playground", name: "Dev" } as never]);
    const live = ctx.getDoc("dev-playground");
    if (random() < 0.5) {
      const writer = new Y.Doc();
      Y.applyUpdate(writer, Y.encodeStateAsUpdate(server));
      const before = Y.encodeStateVector(writer);
      addItem(writer, "remote-0-".padEnd(1 + pick(random, APP_DOCUMENT_UPDATE_MAX_BYTES - 1_024), "r"));
      Y.applyUpdate(server, Y.encodeStateAsUpdate(writer, before));
    }
    const model = new Y.Doc();
    Y.applyUpdate(model, Y.encodeStateAsUpdate(server));
    const edits: Uint8Array[] = [];
    const take = (update: Uint8Array) => edits.push(update);
    live.on("update", take);
    await act(async () => {
      const count = 2 + pick(random, 5);
      for (let index = 0; index < count; index += 1) addItem(live, `edit-${index}-`.padEnd(1 + pick(random, 150 * 1024), "e"));
    });
    live.off("update", take);
    let refusedOne = false;
    for (const edit of edits) {
      const trial = new Y.Doc();
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(model));
      Y.applyUpdate(trial, edit);
      if (encodedBytes(trial) > APP_DOCUMENT_MAX_BYTES) {
        refusedOne = true;
        break;
      }
      Y.applyUpdate(model, edit);
    }
    await advance(3_000);
    return { sfu, server, model, refusedOne, edits };
  };

  it("saves every edit of a burst that fits after the ones before it, over random sizes near the limit and another writer's change it has not seen yet", async () => {
    let refusedBursts = 0;
    let savedBursts = 0;
    for (let seed = 1; seed <= 32; seed += 1) {
      const { sfu, server, model, refusedOne } = await burstNearTheLimit(seed);
      expect({ seed, saved: labels(server) }).toEqual({ seed, saved: labels(model) });
      expect({ seed, reasons: sfu.reasons }).toEqual({ seed, reasons: refusedOne ? ["too-large"] : [] });
      if (refusedOne) refusedBursts += 1;
      else savedBursts += 1;
      await act(async () => root.unmount());
      root = createRoot(container);
    }
    expect(refusedBursts).toBeGreaterThan(5);
    expect(savedBursts).toBeGreaterThan(5);
  }, 60_000);

  it("never says a document's saved copy stays under a limit it is over, even with undo history kept, and answers exactly when half a second has passed since it was last asked", async () => {
    let under = 0;
    let over = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seeded(seed);
      const doc = new Y.Doc();
      const undo = seed % 2 === 0 ? new Y.UndoManager([doc.getText("t"), doc.getMap("m")], { captureTimeout: 0 }) : null;
      const peer = new Y.Doc();
      let askedAt = Number.NEGATIVE_INFINITY;
      for (let step = 0; step < 60; step += 1) {
        const kind = random();
        const text = doc.getText("t");
        if (kind < 0.3) text.insert(pick(random, text.length + 1), "w".repeat(1 + pick(random, 4_000)));
        else if (kind < 0.45 && text.length > 0) {
          const at = pick(random, text.length);
          text.delete(at, Math.min(text.length - at, 1 + pick(random, 3_000)));
        } else if (kind < 0.6) doc.getMap("m").set(`k${pick(random, 5)}`, "v".repeat(pick(random, 2_000)));
        else if (kind < 0.75) {
          const before = Y.encodeStateVector(peer);
          Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
          peer.getArray("a").push(["p".repeat(1 + pick(random, 3_000))]);
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before), "remote");
        } else await vi.advanceTimersByTimeAsync(pick(random, 700));
        const actual = savedBytes(doc);
        const limit = Math.max(0, actual - 6_000 + pick(random, 12_000));
        const settled = Date.now() - askedAt >= 500;
        const answer = savedSizeStaysUnder(doc, limit);
        if (answer) under += 1;
        else over += 1;
        if (answer) expect({ seed, step, actual, limit }).toEqual({ seed, step, actual: Math.min(actual, limit), limit });
        if (settled) expect({ seed, step, answer }).toEqual({ seed, step, answer: actual <= limit });
        askedAt = Date.now();
      }
      if (undo) expect(encodedBytes(doc)).toBeGreaterThan(savedBytes(doc));
      undo?.destroy();
    }
    expect(under).toBeGreaterThan(200);
    expect(over).toBeGreaterThan(200);
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

describe("a change over the cap", () => {
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

  it("goes out as byte ranges of the encoded update that join back into it exactly", async () => {
    const { missing } = editedCopy();
    const sent: Array<{ update: Uint8Array; part?: { id: string; index: number; count: number } }> = [];
    const queue = createUploadQueue(
      (_appId, _replicaId, update, part) => {
        sent.push({ update, part });
        return true;
      },
      { stagesParts: () => true },
    );

    queue.add("board", "r", missing);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toHaveLength(Math.ceil(missing.length / MAX));
    expect(sent.every(({ update }) => update.length <= MAX)).toBe(true);
    expect(sent.map(({ part }) => part?.count)).toEqual(sent.map(() => sent.length));
    expect(joinBytes(sent.map(({ update }) => update))).toEqual(missing);
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
    expect(joinBytes(sent.map(({ update }) => update))).toEqual(missing);

    sent.length = 0;
    stages = false;
    queue.add("board", "r", missing);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ update: missing, part: undefined }]);
  });
});

describe("every change over random documents and histories", () => {
  const MAX = APP_DOCUMENT_UPDATE_MAX_BYTES;
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = (random: () => number, below: number) => Math.floor(random() * below);
  const editOnce = (doc: Y.Doc, random: () => number, bigChance: number) => {
    const big = random() < bigChance;
    const text = doc.getText("t");
    const list = doc.getArray<string>("a");
    const map = doc.getMap<string>("m");
    const kind = random();
    doc.transact(() => {
      if (kind < 0.35) text.insert(pick(random, text.length + 1), "w".repeat(big ? 150_000 + pick(random, 250_000) : 1 + pick(random, 40)));
      else if (kind < 0.5 && text.length > 0) {
        const at = pick(random, text.length);
        text.delete(at, Math.min(text.length - at, 1 + pick(random, 200)));
      } else if (kind < 0.75) list.push(Array.from({ length: 1 + pick(random, 3) }, (_, index) => `${index}`.padEnd(big ? 100_000 : 20, "x")));
      else if (kind < 0.85 && list.length > 0) list.delete(pick(random, list.length), 1);
      else {
        map.set(`k${pick(random, 6)}`, "v".repeat(big ? 120_000 : 1 + pick(random, 30)));
        if (random() < 0.5) text.insert(0, "and text");
      }
    });
  };
  const contentOf = (doc: Y.Doc) => ({ t: doc.getText("t").toString(), a: doc.getArray("a").toJSON(), m: doc.getMap("m").toJSON() });
  const capture = (doc: Y.Doc, run: () => void): Uint8Array[] => {
    const updates: Uint8Array[] = [];
    const take = (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") updates.push(update);
    };
    doc.on("update", take);
    run();
    doc.off("update", take);
    return updates;
  };

  const runHistory = async (seed: number) => {
    const random = seeded(seed);
    const server = new Y.Doc();
    const client = new Y.Doc();
    const changes: Uint8Array[] = [];
    const fromSnapshot = seed % 3 === 0;
    if (fromSnapshot) {
      for (let index = 0; index < 1 + pick(random, 4); index += 1) editOnce(client, random, 0.6);
      changes.push(Y.encodeStateAsUpdate(client));
    } else {
      const peers = Array.from({ length: 1 + pick(random, 3) }, () => new Y.Doc());
      for (let round = 0; round < 4 + pick(random, 6); round += 1) {
        const peer = peers[pick(random, peers.length)];
        for (const update of capture(peer, () => editOnce(peer, random, 0.05))) {
          Y.applyUpdate(server, update, "remote");
          Y.applyUpdate(client, update, "remote");
          peers.forEach((other) => other !== peer && Y.applyUpdate(other, update, "remote"));
        }
      }
      for (let round = 0; round < pick(random, 4); round += 1) {
        const peer = peers[pick(random, peers.length)];
        for (const update of capture(peer, () => editOnce(peer, random, 0.3))) Y.applyUpdate(client, update, "remote");
      }
      const missing = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
      if (!Y.snapshotContainsUpdate(Y.snapshot(server), missing)) changes.push(missing);
    }
    for (let round = 0; round < 3 + pick(random, 8); round += 1) changes.push(...capture(client, () => editOnce(client, random, 0.2)));
    if (random() < 0.6) {
      const before = Y.encodeStateVector(client);
      for (let round = 0; round < 2 + pick(random, 4); round += 1) editOnce(client, random, 0.35);
      changes.push(Y.encodeStateAsUpdate(client, before));
    }

    const docLimit = seed % 2 === 0 ? Number.POSITIVE_INFINITY : 200_000 + pick(random, 1_000_000);
    const joined: Uint8Array[] = [];
    const plain: Uint8Array[] = [];
    let staged: Uint8Array[] = [];
    const accept = (update: Uint8Array) => {
      const trial = new Y.Doc();
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(server));
      Y.applyUpdate(trial, update);
      const pending = trial.store.pendingStructs !== null || trial.store.pendingDs !== null;
      if (!pending && Y.encodeStateAsUpdate(trial).length <= docLimit) Y.applyUpdate(server, update);
    };
    const queue = createUploadQueue(
      (_appId, _replicaId, update, part) => {
        if (update.length > MAX) return true;
        if (!part) {
          staged = [];
          plain.push(update);
          accept(update);
          return true;
        }
        if (part.index === 0) staged = [];
        staged.push(update);
        if (staged.length === part.count) {
          const whole = joinBytes(staged);
          joined.push(whole);
          accept(whole);
          staged = [];
        }
        return true;
      },
      { stagesParts: () => true },
    );
    changes.forEach((change) => queue.add("board", "r", change));
    await vi.advanceTimersByTimeAsync(changes.length * 200 + 1_000);
    return { server, client, changes, joined, plain, docLimit };
  };

  it("lands whole or not at all, matches the client when nothing is refused, and is never rebuilt from re-encoded pieces", async () => {
    let checked = 0;
    let staged = 0;
    let partial = 0;
    for (let seed = 1; seed <= 48; seed += 1) {
      const { server, client, changes, joined, plain, docLimit } = await runHistory(seed);
      const saved = Y.snapshot(server);
      const vector = Y.decodeStateVector(Y.encodeStateVector(server));
      for (const change of changes) {
        checked += 1;
        const whole = Y.snapshotContainsUpdate(saved, change);
        const { from, to } = Y.parseUpdateMeta(change);
        const none = [...to.keys()].every((clientId) => (vector.get(clientId) ?? 0) <= (from.get(clientId) ?? 0));
        if (!whole && !none) partial += 1;
      }
      const same = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
      let next = 0;
      for (const upload of plain) {
        while (next < changes.length && changes[next].length > MAX) next += 1;
        let end = next;
        while (end < changes.length && changes[end].length <= MAX && !same(upload, end === next ? changes[next] : Y.mergeUpdates(changes.slice(next, end + 1)))) end += 1;
        expect({ seed, uploadIsWholeChanges: end < changes.length && changes[end].length <= MAX }).toEqual({ seed, uploadIsWholeChanges: true });
        next = end + 1;
      }
      for (const whole of joined) {
        staged += 1;
        expect({ seed, joinedIsAChange: changes.some((change) => change.length === whole.length && change.every((byte, index) => byte === whole[index])) }).toEqual({ seed, joinedIsAChange: true });
      }
      if (docLimit === Number.POSITIVE_INFINITY) {
        expect({ seed, content: contentOf(server) }).toEqual({ seed, content: contentOf(client) });
        expect({ seed, vector: Y.encodeStateVector(server) }).toEqual({ seed, vector: Y.encodeStateVector(client) });
      }
    }

    expect(partial).toBe(0);
    expect(checked).toBeGreaterThan(200);
    expect(staged).toBeGreaterThan(10);
  }, 120_000);
});
