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
  vi.restoreAllMocks();
});

it("acknowledges the current native Wheel add only after the SFU echoes the committed bytes to its writer", async () => {
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
  host("update", "h-echo", { update: Buffer.from(update).toString("base64") });
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
