import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    secret: { type: "string" },
    label: { type: "string", default: "sfu" },
    updates: { type: "string", default: "100" },
  },
});
const url = values.url;
const secret = values.secret;
if (!url || !secret) throw new Error("Usage: --url <sfu url> --secret <SFU_SECRET> [--label name] [--updates n]");
const run = `${values.label}-${Date.now().toString(36)}`;

const quantile = (samples: number[], q: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};
const round = (value: number): number => Math.round(value * 100) / 100;
const summary = (samples: number[]) => ({
  n: samples.length,
  median: round(quantile(samples, 0.5)),
  p95: round(quantile(samples, 0.95)),
  p99: round(quantile(samples, 0.99)),
  max: round(Math.max(...samples)),
});

const join = async (roomId: string, name: string): Promise<Socket> => {
  const sessionId = `${run}-${name}`;
  const token = jwt.sign(
    {
      userId: `bot-${sessionId}`,
      name,
      isHost: true,
      isAdmin: true,
      allowRoomCreation: true,
      clientId: "conclave",
      sessionId,
      joinMode: "meeting",
    },
    secret,
    { expiresIn: "1h" },
  );
  const socket = io(url, { auth: { token }, transports: ["websocket"], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const joined = (await socket.timeout(30_000).emitWithAck("joinRoom", {
    roomId,
    sessionId,
    displayName: name,
  })) as { status?: string; error?: string };
  if (joined.error || joined.status !== "joined") throw new Error(`${name} could not join: ${JSON.stringify(joined)}`);
  return socket;
};

const openBoard = async (socket: Socket): Promise<void> => {
  const opened = (await socket.timeout(10_000).emitWithAck("apps:open", { appId: "board" })) as { success: boolean };
  if (!opened.success) throw new Error("apps:open failed");
};

const syncedBytes = async (socket: Socket): Promise<number> => {
  const response = (await socket.timeout(60_000).emitWithAck("apps:yjs:sync", {
    appId: "board",
    syncMessage: Y.encodeStateVector(new Y.Doc()),
  })) as { syncMessage?: ArrayBuffer | Uint8Array; error?: string };
  if (!response.syncMessage) throw new Error(`sync failed: ${response.error}`);
  return response.syncMessage.byteLength;
};

const measureSmallUpdates = async (count: number) => {
  const roomId = `${run}-small`;
  const sender = await join(roomId, "sender");
  const receiver = await join(roomId, "receiver");
  await openBoard(sender);
  const author = new Y.Doc();
  const text = author.getText("t");
  const sent: { update: Uint8Array; at: number }[] = [];
  const latencies: number[] = [];
  let mismatched = 0;
  receiver.on("apps:yjs:update", ({ update }: { update: ArrayBuffer }) => {
    const expected = sent[latencies.length + mismatched];
    if (!expected || Buffer.compare(Buffer.from(update), Buffer.from(expected.update)) !== 0) {
      mismatched += 1;
      return;
    }
    latencies.push(performance.now() - expected.at);
  });
  for (let index = 0; index < count; index += 1) {
    const before = Y.encodeStateVector(author);
    text.insert(text.length, "k");
    const update = Y.encodeStateAsUpdate(author, before);
    sent.push({ update, at: performance.now() });
    sender.emit("apps:yjs:update", { appId: "board", update });
    await sleep(40);
  }
  await sleep(1_000);
  sender.disconnect();
  receiver.disconnect();
  return { ...summary(latencies), received: latencies.length, mismatched, sent: count };
};

const attackUpdates = (): Uint8Array[] => {
  const attacker = new Y.Doc();
  const text = attacker.getText("t");
  const insertBefore = Y.encodeStateVector(attacker);
  text.insert(0, "x".repeat(120_000));
  const updates = [Y.encodeStateAsUpdate(attacker, insertBefore)];
  for (let end = 120_000; end > 0; end -= 40_000) {
    const before = Y.encodeStateVector(attacker);
    attacker.transact(() => {
      for (let index = end - 2; index >= end - 40_000; index -= 2) text.delete(index, 1);
    });
    updates.push(Y.encodeStateAsUpdate(attacker, before));
  }
  return updates;
};

const measureAttack = async (updates: Uint8Array[]) => {
  const attackedRoom = `${run}-attacked`;
  const attacker = await join(attackedRoom, "attacker");
  const peer = await join(attackedRoom, "peer");
  const observer = await join(`${run}-elsewhere`, "observer");
  await openBoard(attacker);
  let relayed = 0;
  peer.on("apps:yjs:update", () => {
    relayed += 1;
  });
  const pings: number[] = [];
  let pinging = true;
  const pingLoop = (async () => {
    while (pinging) {
      const started = performance.now();
      await observer.timeout(60_000).emitWithAck("apps:getState");
      pings.push(performance.now() - started);
      await sleep(10);
    }
  })();
  await sleep(500);
  const baseline = pings.length;
  const started = performance.now();
  for (const update of updates) {
    attacker.emit("apps:yjs:update", { appId: "board", update });
    await sleep(50);
  }
  const docBytes = await syncedBytes(attacker);
  const settledMs = performance.now() - started;
  await sleep(300);
  pinging = false;
  await pingLoop;
  attacker.disconnect();
  peer.disconnect();
  observer.disconnect();
  const during = pings.slice(baseline);
  return {
    pings: summary(during),
    pingsOver50ms: during.filter((ms) => ms > 50).length,
    baselinePingMedian: round(quantile(pings.slice(0, baseline), 0.5)),
    updatesSent: updates.length,
    updateBytes: updates.map((update) => update.length),
    relayedToPeer: relayed,
    docBytes,
    settledMs: round(settledMs),
  };
};

const updates = attackUpdates();
const smallUpdates = await measureSmallUpdates(Number(values.updates));
const attack = await measureAttack(updates);
console.log(JSON.stringify({ label: values.label, run, smallUpdates, attack }));
process.exit(0);
