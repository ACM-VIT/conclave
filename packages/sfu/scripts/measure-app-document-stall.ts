import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  addElement,
  DEFAULT_WHITEBOARD_PAGE_ID,
  getPageElements,
} from "@conclave/apps-sdk/whiteboard/document";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";

type WhiteboardElement = Parameters<typeof addElement>[2];

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    label: { type: "string", default: "sfu" },
    updates: { type: "string", default: "25" },
  },
});
const secret = process.env.SFU_SECRET;
if (!values.url || !secret) {
  throw new Error("Set SFU_SECRET for the local SFU and pass --url http://127.0.0.1:<port> [--label name] [--updates n]");
}
const url = new URL(values.url);
assert.ok(
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.href === url.origin + "/",
  "Expected a loopback SFU origin",
);
const count = Number(values.updates);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 100, "--updates must be an integer from 1 to 100");

const run = "board-bench-" + randomUUID();
const appId = "whiteboard";
const timeoutMs = 5_000;
const sockets: Socket[] = [];
const documents: Y.Doc[] = [];

const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;
  const quantile = (q: number) => round(sorted[Math.ceil(q * sorted.length) - 1]);
  return { n: samples.length, median: quantile(0.5), p95: quantile(0.95), max: round(sorted[sorted.length - 1]) };
};

const ask = (socket: Socket, event: string, ...args: unknown[]): Promise<unknown> =>
  socket.timeout(timeoutMs).emitWithAck(event, ...args);

const join = async (roomId: string, name: string, isHost: boolean): Promise<Socket> => {
  const token = jwt.sign(
    {
      userId: run + "-" + name,
      name,
      isHost,
      isForcedHost: isHost,
      allowRoomCreation: isHost,
      clientId: "conclave",
    },
    secret,
    { expiresIn: "5m" },
  );
  const socket = io(url.origin, { auth: { token }, transports: ["websocket"], reconnection: false, timeout: timeoutMs });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const joined = (await ask(socket, "joinRoom", { roomId, displayName: name })) as { status?: string; error?: string };
  assert.equal(joined.status, "joined", name + " could not join: " + JSON.stringify(joined));
  return socket;
};

const sync = async (socket: Socket): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  documents.push(doc);
  const response = (await ask(socket, "apps:yjs:sync", {
    appId,
    syncMessage: Y.encodeStateVector(doc),
    canRetry: true,
    wholeChanges: true,
  })) as { syncMessage?: Uint8Array; error?: string };
  assert.ok(response.syncMessage && !response.error, "Whiteboard sync failed: " + response.error);
  Y.applyUpdate(doc, response.syncMessage);
  return doc;
};

const waitForRelay = (socket: Socket, doc: Y.Doc, expected: WhiteboardElement[]) =>
  new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Peer did not receive whiteboard edit " + expected.length)), timeoutMs);
    function finish(error?: Error) {
      clearTimeout(timer);
      socket.off("apps:yjs:update", onUpdate);
      if (error) reject(error);
      else resolve(performance.now());
    }
    function onUpdate(message: { appId: string; update: Uint8Array }) {
      if (message.appId !== appId) return;
      try {
        Y.applyUpdate(doc, message.update);
        assert.deepEqual(getPageElements(doc, DEFAULT_WHITEBOARD_PAGE_ID), expected);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    socket.on("apps:yjs:update", onUpdate);
  });

try {
  const sender = await join(run, "sender", true);
  const receiver = await join(run, "receiver", false);
  const observer = await join(run + "-other", "observer", true);
  const opened = (await ask(sender, "apps:open", { appId })) as { success?: boolean };
  assert.equal(opened.success, true, "Could not open the whiteboard");
  const [author, replica] = await Promise.all([sync(sender), sync(receiver)]);
  const edits: WhiteboardElement[] = [];
  const relayTimes: number[] = [];
  const otherRoomTimes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = Y.encodeStateVector(author);
    const edit = {
      id: "stroke-" + index,
      type: "stroke",
      tool: "pen",
      points: [{ x: index, y: index }, { x: index + 8, y: index + 4 }],
      color: "#ffffff",
      width: 2,
    } satisfies WhiteboardElement;
    edits.push(edit);
    addElement(author, DEFAULT_WHITEBOARD_PAGE_ID, edit);
    const update = Y.encodeStateAsUpdate(author, before);
    const relay = waitForRelay(receiver, replica, edits);
    const start = performance.now();
    const write = ask(sender, "apps:yjs:update", { appId, update });
    const otherRoom = ask(observer, "apps:getState").then((response) => {
      const at = performance.now();
      assert.equal(typeof (response as { revision?: number }).revision, "number", "Other room did not return app state");
      return at;
    });
    const [relayedAt, readAt] = await Promise.all([relay, otherRoom, write]);
    relayTimes.push(relayedAt - start);
    otherRoomTimes.push(readAt - start);
    await sleep(40);
  }
  const cold = await join(run, "cold", false);
  const saved = await sync(cold);
  assert.deepEqual(getPageElements(saved, DEFAULT_WHITEBOARD_PAGE_ID), edits, "Server snapshot lost whiteboard edits");
  console.log(JSON.stringify({
    label: values.label,
    run,
    committedEdits: edits.length,
    peerRelayMs: summarize(relayTimes),
    otherRoomReadMs: summarize(otherRoomTimes),
  }));
} finally {
  sockets.forEach((socket) => socket.disconnect());
  documents.forEach((doc) => doc.destroy());
}
