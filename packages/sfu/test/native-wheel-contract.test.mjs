import * as Y from "yjs";
import { NativeEmbedSession, encodeEnvelope } from "@conclave/apps-sdk/native-embed";
import { getEntries } from "@conclave/apps-sdk/wheel/core";
import { afterEach, expect, it, vi } from "vitest";
import { runWheelCommand } from "../../apps-sdk/src/native-embed/wheel/commands.ts";
import { createAppDocumentPool } from "../server/apps/documents/pool.ts";
import { inAppRoom } from "./fixtures/app-room.ts";

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("shows a released Wheel entry after a current client joins the same room", async () => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 5_000, maxDocumentBytes: 1024 * 1024 });
  cleanups.push(() => pool.close());
  const room = inAppRoom(pool, "released-wheel-list", { appId: "wheel" });
  await room.open();
  // Captured from createWheelDoc() and addEntry(doc, "Ada") at 859c81a2 with Yjs 13.6.33.
  const update = "AQJlACcBBXdoZWVsB2VudHJpZXMACABlAAF2AgJpZHcKbG95dzN2MjgtaQVsYWJlbHcDQWRhAA==";
  expect((await room.acknowledged({ update })).receipt).toEqual({ committed: true });

  const { doc } = await room.joinDocument();
  cleanups.push(() => doc.destroy());
  expect(getEntries(doc).map(({ label }) => label)).toEqual(["Ada"]);
});

it.each(["echo", "snapshot"])("acknowledges a native Wheel add only after the server provides a committed %s", async (confirmation) => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 5_000, maxDocumentBytes: 1024 * 1024 });
  cleanups.push(() => pool.close());
  const room = inAppRoom(pool, "writer-echo-wheel", { appId: "wheel" });
  await room.open();
  const scope = { callSessionId: "fixture-call", appSessionId: "fixture-wheel", appId: "wheel" };
  const local = new Y.Doc();
  const outbox = [];
  let receive = () => undefined;
  const session = new NativeEmbedSession({
    platform: "ios",
    post: (raw) => outbox.push(raw),
    onMessage: (handler) => { receive = handler; },
  }, scope, local);
  cleanups.push(() => { session.close(); local.destroy(); });
  session.start((envelope, repeat, doc) => runWheelCommand(doc, envelope.type, envelope.payload, {
    repeat, synced: true, canEdit: true, spinning: false,
    requestSpin: () => ({ ok: false }),
    setSounds: () => ({ ok: false }),
  }));
  const host = (type, requestId, payload) =>
    expect(receive(encodeEnvelope(type, scope, requestId, payload))).toBe("none");
  const snapshot = await room.syncFrom(local);
  host("status", "h-live", { connection: "live", readOnly: false });
  host("snapshot", "h-snapshot", {
    syncMessage: Buffer.from(snapshot.syncMessage).toString("base64"),
    stateVector: Buffer.from(snapshot.stateVector).toString("base64"),
  });
  host("addEntries", "h-add", { labels: ["Ada"], tokens: ["add-ada"], sentAt: Date.now() });
  const messages = () => outbox.map((raw) => JSON.parse(raw));
  const addAck = () => messages().find((message) => message.type === "ack" && message.requestId === "h-add");
  expect(getEntries(local).map(({ label }) => label)).toEqual(["Ada"]);
  expect(addAck()).toBeUndefined();

  await Promise.resolve();
  const upload = messages().find((message) => message.type === "update");
  expect(upload?.payload.update).toEqual(expect.any(String));
  const { inbox } = await room.acknowledged({ update: upload.payload.update });
  const ownEcho = inbox.find(({ event }) => event === "apps:yjs:update");
  expect(ownEcho).toBeDefined();
  const { update } = ownEcho.payload;
  if (confirmation === "echo") {
    host("update", "h-echo", { update: Buffer.from(update).toString("base64") });
  } else {
    await vi.waitFor(() => {
      expect(messages().find(({ type, payload }) => type === "sync" && payload.purpose === "wheel-add-confirmation")).toBeDefined();
    }, { timeout: 2_000 });
    const first = messages().find(({ type, payload }) => type === "sync" && payload.purpose === "wheel-add-confirmation");
    expect(addAck()).toBeUndefined();
    host("snapshot", first.requestId, { syncMessage: Buffer.from([0, 0]).toString("base64") });
    expect(addAck()).toBeUndefined();
    const request = await vi.waitFor(() => {
      const next = messages().find(({ type, requestId, payload }) =>
        requestId !== first.requestId && type === "sync" && payload.purpose === "wheel-add-confirmation");
      expect(next).toBeDefined();
      return next;
    }, { timeout: 2_000 });
    const confirmed = await room.requestSync(Buffer.from(request.payload.stateVector, "base64"));
    expect(confirmed.syncMessage).toBeDefined();
    host("snapshot", request.requestId, {
      syncMessage: Buffer.from(confirmed.syncMessage).toString("base64"),
      stateVector: Buffer.from(confirmed.stateVector).toString("base64"),
    });
  }
  expect(addAck()?.payload).toEqual({ ok: true, added: [0] });

  const { doc: cold } = await room.joinDocument();
  cleanups.push(() => cold.destroy());
  expect(getEntries(cold).map(({ label }) => label)).toEqual(["Ada"]);
  expect(runWheelCommand(cold, "addOutcome", { tokens: ["add-ada"], sentAt: Date.now() }, {
    repeat: false, synced: true, canEdit: true, spinning: false,
    requestSpin: () => ({ ok: false }),
    setSounds: () => ({ ok: false }),
  })).toEqual({ ok: true, added: [0] });
});

it.each(["echo", "resync", "resync with a probe in flight"])("gives the next Wheel upload a full echo window after %s", async (boundary) => {
  vi.useFakeTimers();
  const scope = { callSessionId: "timing-call", appSessionId: "timing-wheel", appId: "wheel" };
  const local = new Y.Doc();
  const messages = [];
  let receive = () => undefined;
  const session = new NativeEmbedSession({
    platform: "ios",
    post: (raw) => messages.push(JSON.parse(raw)),
    onMessage: (handler) => { receive = handler; },
  }, scope, local);
  cleanups.push(() => { session.close(); local.destroy(); });
  session.start((envelope, repeat, doc) => runWheelCommand(doc, envelope.type, envelope.payload, {
    repeat, synced: true, canEdit: true, spinning: false,
    requestSpin: () => ({ ok: false }),
    setSounds: () => ({ ok: false }),
  }));
  const host = (type, id, payload) => expect(receive(encodeEnvelope(type, scope, id, payload))).toBe("none");
  const snapshot = { syncMessage: "AAA=", stateVector: "AA==" };
  const add = (label, id) => host("addEntries", id, { labels: [label], tokens: [id], sentAt: Date.now() });
  const uploads = () => messages.filter(({ type }) => type === "update");
  const probes = () => messages.filter(({ type, payload }) => type === "sync" && payload.purpose === "wheel-add-confirmation");
  const firstAck = () => messages.find(({ type, requestId }) => type === "ack" && requestId === "add-a");
  host("status", "live", { connection: "live" });
  host("snapshot", "initial", snapshot);
  add("Ada", "add-a");
  await vi.advanceTimersByTimeAsync(0);
  expect(uploads()).toHaveLength(1);

  if (boundary === "echo") {
    host("update", "echo-a", uploads()[0].payload);
    expect(firstAck()?.payload).toEqual({ ok: true, added: [0] });
    await vi.advanceTimersByTimeAsync(700);
    add("Lin", "add-b");
  } else {
    if (boundary === "resync") {
      host("status", "reconnecting", { connection: "reconnecting" });
      host("status", "live-again", { connection: "live" });
      host("resync", "resync", {});
      await vi.advanceTimersByTimeAsync(700);
    } else {
      await vi.advanceTimersByTimeAsync(750);
      expect(probes()).toHaveLength(1);
      host("resync", "resync", {});
      host("snapshot", probes()[0].requestId, { syncMessage: uploads()[0].payload.update });
      expect(firstAck()).toBeUndefined();
    }
    host("snapshot", "after-resync", snapshot);
  }

  const previousProbes = boundary === "resync with a probe in flight" ? 1 : 0;
  await vi.advanceTimersByTimeAsync(0);
  expect(uploads()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(probes()).toHaveLength(previousProbes);
  await vi.advanceTimersByTimeAsync(650);
  expect(probes()).toHaveLength(previousProbes + 1);
});
