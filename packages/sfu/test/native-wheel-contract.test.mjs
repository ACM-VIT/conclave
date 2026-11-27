import * as Y from "yjs";
import { NativeEmbedSession, encodeEnvelope } from "@conclave/apps-sdk/native-embed";
import { addEntries, addEntriesOnce, getEntries, getWheelNames, readAddRecord, removeEntryById, reorderEntries } from "@conclave/apps-sdk/wheel/core";
import { afterEach, expect, it, vi } from "vitest";
import { runWheelCommand } from "../../apps-sdk/src/native-embed/wheel/commands.ts";
import { createAppDocumentPool } from "../server/apps/documents/pool.ts";
import { inAppRoom } from "./fixtures/app-room.ts";

const cleanups = [];
const releasedAda = "AQJlACcBBXdoZWVsB2VudHJpZXMACABlAAF2AgJpZHcKbG95dzN2MjgtaQVsYWJlbHcDQWRhAA==";

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
  expect((await room.acknowledged({ update: releasedAda })).receipt).toEqual({ committed: true });

  const { doc } = await room.joinDocument(2);
  cleanups.push(() => doc.destroy());
  expect(getEntries(doc).map(({ label }) => label)).toEqual(["Ada"]);
});

const edit = (doc, change) => {
  const before = Y.encodeStateVector(doc);
  change();
  return Y.encodeStateAsUpdate(doc, before);
};

const wheelRoom = async (id, options) => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 5_000, maxDocumentBytes: 1024 * 1024, ...options });
  cleanups.push(() => pool.close());
  const room = inAppRoom(pool, id, { appId: "wheel" });
  await room.open();
  return room;
};

const copy = async (peer) => {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  const reply = await peer.sync(doc);
  expect(reply.syncMessage).toBeInstanceOf(Uint8Array);
  Y.applyUpdate(doc, reply.syncMessage);
  return doc;
};

const releasedEntries = (doc) => doc.getMap("wheel").get("entries");
const labels = (doc) => getEntries(doc).map(({ label }) => label);

it.each(["released", "current"])("keeps one membership list when the %s path goes first", async (first) => {
  const room = await wheelRoom(`wheel-first-${first}`);
  const legacy = await room.peer();
  const releasedUpdate = Buffer.from(releasedAda, "base64");
  if (first === "released") {
    expect(await legacy.acknowledged(releasedUpdate)).toEqual({ committed: true });
  }
  const left = await room.peer({ wheelFormat: 2, encoding: "base64", syncs: false });
  const right = await room.peer({ wheelFormat: 2, syncs: false });
  const [a, b] = await Promise.all([copy(left), copy(right)]);
  expect(await left.sync(a)).toMatchObject({ wheelFormat: 2 });
  const updates = [[left, a, "Lin"], [right, b, "Kay"]].map(([peer, doc, label]) =>
    peer.acknowledged(edit(doc, () => expect(addEntries(doc, [label])).toBe(1)), label));
  expect(await Promise.all(updates)).toEqual([{ committed: true }, { committed: true }]);
  if (first === "current") expect(await legacy.acknowledged(releasedUpdate)).toBeUndefined();
  expect(await legacy.settle()).toEqual({ error: "Update your app or refresh this tab to use this Wheel." });
  expect(legacy.states()).toContain(null);
  const cold = await copy(right);
  expect(labels(cold).sort()).toEqual(first === "released" ? ["Ada", "Kay", "Lin"] : ["Kay", "Lin"]);
  expect(releasedEntries(cold)?.length ?? 0).toBe(first === "released" ? 3 : 0);
  expect(cold.getArray("wheel.entries").length).toBe(first === "current" ? 2 : 0);
});

it("refuses an unversioned top-level write instead of hiding it in a released Wheel", async () => {
  const room = await wheelRoom("wheel-unversioned-current");
  expect((await room.acknowledged({ update: releasedAda })).receipt).toEqual({ committed: true });
  const other = await room.peer();
  const writer = await room.peer({ syncs: false });
  const doc = await copy(writer);
  const otherLayout = edit(doc, () => doc.getArray("wheel.entries").push([{ id: "hidden", label: "Hidden" }]));
  expect(await writer.acknowledged(otherLayout, "unversioned")).toBeUndefined();
  expect(writer.inbox).toContainEqual({ event: "apps:yjs:refused", payload: { appId: "wheel", replicaId: "unversioned", reason: "wheel-format" } });
  expect(other.updates()).toEqual([]);
  const current = await room.peer({ wheelFormat: 2 });
  expect(await current.acknowledged(otherLayout)).toBeUndefined();
  const cold = await copy(current);
  expect(labels(cold)).toEqual(["Ada"]);
  expect(cold.getArray("wheel.entries").length).toBe(0);
});

it("keeps names already committed in the top-level list before version negotiation", async () => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 5_000, maxDocumentBytes: 1024 * 1024 });
  const doc = new Y.Doc();
  const cold = new Y.Doc();
  cleanups.push(() => pool.close(), () => doc.destroy(), () => cold.destroy());
  const saved = pool.open();
  addEntries(doc, ["Kay"]);
  expect(await saved.apply(Y.encodeStateAsUpdate(doc))).toEqual({ ok: true });

  const oldWrite = Buffer.from(releasedAda, "base64");
  expect(await saved.applyValidated([oldWrite], false, { preflight: () => null, authorize: () => null }, 1))
    .toMatchObject({ ok: false, reason: "wheel-format" });
  const snapshot = await saved.sync(Y.encodeStateVector(cold));
  expect(snapshot.ok).toBe(true);
  Y.applyUpdate(cold, snapshot.update);
  expect(labels(cold)).toEqual(["Kay"]);
});

it.each([64, 65])("handles released sort, remove and clear with %s committed names", async (count) => {
  const room = await wheelRoom(`wheel-legacy-policy-${count}`);
  expect((await room.acknowledged({ update: releasedAda })).receipt).toEqual({ committed: true });
  const legacy = await room.peer();
  const doc = await copy(legacy);
  const seed = Array.from({ length: count - 1 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }));
  expect(await legacy.acknowledged(edit(doc, () => releasedEntries(doc).push(seed)))).toEqual({ committed: true });
  const sorted = await copy(legacy);
  const sort = edit(sorted, () => sorted.transact(() => {
    const entries = releasedEntries(sorted);
    const visible = entries.toArray().slice(0, 64);
    entries.delete(0, entries.length);
    entries.push(visible.reverse());
  }));
  const receipt = await legacy.acknowledged(sort, "legacy-sort");
  expect(receipt).toEqual(count === 64 ? { committed: true } : undefined);
  const afterSort = await copy(legacy);
  expect(releasedEntries(afterSort).length).toBe(count);
  expect(labels(afterSort)[0]).toBe(count === 64 ? "Row 62" : "Ada");

  expect(await legacy.acknowledged(edit(afterSort, () => releasedEntries(afterSort).delete(0, 1))))
    .toEqual({ committed: true });
  const afterRemove = await copy(legacy);
  expect(releasedEntries(afterRemove).length).toBe(count - 1);
  expect(await legacy.acknowledged(edit(afterRemove, () => releasedEntries(afterRemove).delete(0, count - 1))))
    .toEqual({ committed: true });
  expect(labels(await copy(await room.peer({ wheelFormat: 2 })))).toEqual([]);
});

it.each(["sort", "remove", "clear"])("rejects a stale released %s after the version boundary", async (action) => {
  const room = await wheelRoom(`wheel-old-${action}`);
  expect((await room.acknowledged({ update: releasedAda })).receipt).toEqual({ committed: true });
  const legacy = await room.peer();
  const stale = await copy(legacy);
  const update = edit(stale, () => {
    const array = releasedEntries(stale);
    const rows = array.toArray();
    array.delete(0, 1);
    if (action === "sort") array.push(rows.reverse());
  });
  const current = await room.peer({ wheelFormat: 2 });
  expect(await legacy.acknowledged(update, "old")).toBeUndefined();
  expect(legacy.inbox).toContainEqual({ event: "apps:yjs:refused", payload: { appId: "wheel", replicaId: "old", reason: "wheel-format" } });
  expect(current.updates()).toEqual([]);
  expect(labels(await copy(current))).toEqual(["Ada"]);
});

it("retains a committed overflow receipt, order and removal on a released list after worker reload", async () => {
  const workerUrl = new URL("./fixtures/stalling-app-document-worker.ts", import.meta.url);
  const room = await wheelRoom("wheel-format-reload", { workerUrl });
  expect((await room.acknowledged({ update: releasedAda })).receipt).toEqual({ committed: true });
  const left = await room.peer({ wheelFormat: 2 });
  const right = await room.peer({ wheelFormat: 2 });
  const seed = await copy(left);
  const initial = edit(seed, () => addEntries(seed, Array.from({ length: 62 }, (_, i) => `Row ${i}`)));
  expect(await left.acknowledged(initial)).toEqual({ committed: true });

  const [a, b] = await Promise.all([copy(left), copy(right)]);
  const at = 100;
  for (const [peer, doc, label] of [[left, a, "Lin"], [right, b, "Kay"]]) {
    expect(await peer.acknowledged(edit(doc, () => addEntriesOnce(doc, [{ label, token: `add-${label}` }], at))))
      .toEqual({ committed: true });
  }
  const [reorderer, remover] = await Promise.all([copy(left), copy(right)]);
  expect(getWheelNames(reorderer).waiting).toHaveLength(1);
  const removed = getEntries(remover)[0];
  const order = edit(reorderer, () => reorderEntries(reorderer, getEntries(reorderer).reverse()));
  const removal = edit(remover, () => removeEntryById(remover, removed.id));
  expect(await Promise.all([left.acknowledged(order), right.acknowledged(removal)])).toEqual([{ committed: true }, { committed: true }]);
  const before = await copy(left);
  expect(labels(before)).toHaveLength(64);
  expect(labels(before)).not.toContain(removed.label);
  expect(labels(before)).toEqual(expect.arrayContaining(["Lin", "Kay"]));
  expect(await left.acknowledged(edit(before, () => before.getText("test").insert(0, "CRASH")))).toBeUndefined();
  const cold = await copy(right);
  expect(labels(cold)).toEqual(labels(before));
  expect([...readAddRecord(cold, at).added].sort()).toEqual(["add-Kay", "add-Lin"]);
  expect(cold.getText("test").length).toBe(0);
  expect(await room.close()).toMatchObject({ success: true });
  expect(await room.present("wheel")).toMatchObject({ success: true });
  expect(await room.requestSync(Uint8Array.of(0))).toHaveProperty("error");
  expect(labels(await copy(right))).toEqual(labels(cold));
});

it.each(["echo", "snapshot"])("acknowledges a native Wheel add only after the server provides a committed %s", async (confirmation) => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 5_000, maxDocumentBytes: 1024 * 1024 });
  cleanups.push(() => pool.close());
  const room = inAppRoom(pool, "writer-echo-wheel", { appId: "wheel", wheelFormat: 2 });
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
