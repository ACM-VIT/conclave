import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createAppDocumentPool, type AppDocumentPool } from "../server/apps/documents/pool.js";
import { createStagingBudget, STAGED_CHANGE_IDLE_MS, type StagingBudget } from "../server/apps/documents/staging.js";
import { edit, inAppRoom } from "./fixtures/app-room.js";

const MAX_DOC_BYTES = 1024 * 1024;
const KIB = 1024;

const pools: AppDocumentPool[] = [];
const boardRoom = async (id: string, appChangeStaging?: StagingBudget) => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 20_000, maxDocumentBytes: MAX_DOC_BYTES });
  pools.push(pool);
  const room = inAppRoom(pool, id, { appChangeStaging });
  await room.open();
  return room;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
});

const settled = async (room: Awaited<ReturnType<typeof boardRoom>>) => (await room.joinDocument()).doc.getText("t").toString();

const fill = (room: Awaited<ReturnType<typeof boardRoom>>, author: Y.Doc, chunks: number, size: number) => {
  for (let index = 0; index < chunks; index += 1) {
    room.send(edit(author, (text) => text.insert(text.length, `${index}`.padEnd(size, "f"))));
  }
};

const PART_BYTES = 256 * KIB;

const bigChange = (author: Y.Doc, size: number, mark: string) => edit(author, (text) => text.insert(text.length, mark.padEnd(size, mark)));

const inParts = (update: Uint8Array, size = PART_BYTES) =>
  Array.from({ length: Math.ceil(update.length / size) }, (_, index) => update.slice(index * size, (index + 1) * size));

const sendChange = (room: Awaited<ReturnType<typeof boardRoom>>, parts: Uint8Array[], id = "change-1", replicaId = "copy-1") =>
  parts.forEach((update, index) => room.send(update, replicaId, { id, index, count: parts.length }));

describe("app changes sent in parts", () => {
  it("are offered to new clients in the sync reply", async () => {
    const room = await boardRoom("offer");

    expect(await room.syncFrom(new Y.Doc())).toMatchObject({ stagesParts: true });
  });

  it("are refused whole when together they would pass the document limit, with no part saved or relayed", async () => {
    const room = await boardRoom("near-limit");
    const author = new Y.Doc();
    fill(room, author, 3, 230 * KIB);
    const before = await settled(room);
    const relayedBefore = room.relayed.length;

    const change = bigChange(author, 400 * KIB, "p");
    sendChange(room, inParts(change));
    const after = await settled(room);

    expect(inParts(change).length).toBe(2);
    expect(after).toBe(before);
    expect(after).not.toContain("p");
    expect(room.relayed).toHaveLength(relayedBefore);
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "too-large" }]);
  });

  it("are joined back into the original update, applied once when they fit, and relayed whole", async () => {
    const room = await boardRoom("fits");
    const author = new Y.Doc();
    const change = bigChange(author, 600 * KIB, "q");

    sendChange(room, inParts(change));
    const after = await settled(room);

    expect(after).toBe(author.getText("t").toString());
    expect(room.refused).toEqual([]);
    expect(room.relayed).toEqual([change]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, room.relayed[0]);
    expect(peer.getText("t").toString()).toBe(after);
  });

  it("are refused as interrupted, a passing reason, when a part arrives out of order or names another change, with nothing applied", async () => {
    const room = await boardRoom("order");
    const author = new Y.Doc();
    const [first, second, third] = inParts(bigChange(author, 30 * KIB, "o"), 10 * KIB);

    room.send(first, "copy-1", { id: "c", index: 0, count: 3 });
    room.send(third, "copy-1", { id: "c", index: 2, count: 3 });
    room.send(second, "copy-2", { id: "d", index: 1, count: 3 });
    room.send(second, "copy-3", { id: "e", index: 0, count: 1 });

    expect(await settled(room)).toBe("");
    expect(room.refused.map((refusal) => [refusal.replicaId, refusal.reason])).toEqual([
      ["copy-1", "interrupted"],
      ["copy-2", "interrupted"],
      ["copy-3", "interrupted"],
    ]);
  });

  const partsOf20Kib = (mark: string) => inParts(bigChange(new Y.Doc(), 20 * KIB, mark), 10 * KIB);
  const sendRange = (room: Awaited<ReturnType<typeof boardRoom>>, parts: Uint8Array[], id: string, replicaId: string, from: number, to = parts.length) =>
    parts.slice(from, to).forEach((part, offset) => room.send(part, replicaId, { id, index: from + offset, count: parts.length }));

  it("are dropped the moment the socket asks to join another room, and later parts commit nowhere", async () => {
    const room = await boardRoom("switch");
    const parts = partsOf20Kib("r");

    sendRange(room, parts, "c", "copy-1", 0, 1);
    expect(room.state.appChangeStaging.used()).toBe(parts[0].length);
    await room.moveTo("switch-elsewhere");
    expect(room.state.appChangeStaging.used()).toBe(0);
    sendRange(room, parts, "c", "copy-1", 1);

    expect(await settled(room)).toBe("");
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "interrupted" }]);
  });

  it("are refused on their next part when the room changed by a path that never asked to join", async () => {
    const room = await boardRoom("assigned");
    const parts = partsOf20Kib("s");

    sendRange(room, parts, "s", "copy-1", 0, 1);
    await room.moveTo("assigned-elsewhere", { asksToJoin: false });
    sendRange(room, parts, "s", "copy-1", 1);

    expect(await settled(room)).toBe("");
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "interrupted" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
  });

  it("stop watching an old document once dropped, so closing it later leaves a newer change alone", async () => {
    const room = await boardRoom("old-watch");
    const old = partsOf20Kib("o");
    const newer = partsOf20Kib("n");

    sendRange(room, old, "a", "copy-1", 0, 1);
    await room.moveTo("old-watch-elsewhere");
    sendRange(room, newer, "b", "copy-2", 0, 1);
    [...room.state.rooms.values()].find((candidate) => candidate.id === "old-watch")!.clearAppState("board");
    expect(room.state.appChangeStaging.used()).toBe(newer[0].length);
    sendRange(room, newer, "b", "copy-2", 1);

    expect(await settled(room)).toBe("n".padEnd(20 * KIB, "n"));
  });

  it("are dropped the moment their document is replaced, and later parts commit nowhere", async () => {
    const room = await boardRoom("replaced");
    const parts = partsOf20Kib("d");

    sendRange(room, parts, "d", "copy-2", 0, 1);
    await room.close();
    expect(room.state.appChangeStaging.used()).toBe(0);
    await room.open();
    sendRange(room, parts, "d", "copy-2", 1);

    expect(await settled(room)).toBe("");
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-2", reason: "interrupted" }]);
  });

  it("go whole only to sockets that said they take whole changes, and make every other socket reload the app", async () => {
    const room = await boardRoom("routing");
    const author = new Y.Doc();
    const small = edit(author, (text) => text.insert(0, "small"));
    const large = bigChange(author, 300 * KIB, "w");

    room.send(small, "copy-1");
    sendChange(room, inParts(large), "large", "copy-2");
    await settled(room);

    const channel = room.channelId();
    const whole = `${channel}:whole-changes`;
    expect(room.broadcasts.map(({ to, except, event }) => [to, except ?? null, event])).toEqual([
      [channel, null, "apps:yjs:update"],
      [whole, null, "apps:yjs:update"],
      [channel, whole, "apps:state"],
      [channel, whole, "apps:state"],
    ]);
    expect(room.broadcasts[1].payload).toEqual({ appId: "board", update: large });
    expect(room.broadcasts.slice(2).map(({ payload }) => (payload as { activeAppId: string | null }).activeAppId)).toEqual([null, "board"]);
  });

  it("put a socket among those that take whole changes only when its sync says so, and take it out when it asks to join another room", async () => {
    const room = await boardRoom("membership");
    const whole = `${room.channelId()}:whole-changes`;

    await room.requestSync(new Y.Doc());
    expect(room.joined.has(whole)).toBe(false);
    await room.requestSync(new Y.Doc(), true, true);
    expect(room.joined.has(whole)).toBe(true);
    await room.moveTo("membership-elsewhere");

    expect(room.joined.has(whole)).toBe(false);
  });

  it("are dropped when the client sends a whole update before the last part", async () => {
    const room = await boardRoom("abandoned");
    const author = new Y.Doc();
    const [first] = inParts(bigChange(author, 20 * KIB, "a"), 10 * KIB);
    const other = new Y.Doc();

    room.send(first, "copy-1", { id: "c", index: 0, count: 2 });
    room.send(edit(other, (text) => text.insert(0, "whole")), "copy-2");

    expect(await settled(room)).toBe("whole");
    expect(room.state.appChangeStaging.used()).toBe(0);
  });

  it("are refused while staging when the change alone is bigger than a document can be", async () => {
    const room = await boardRoom("oversized");
    const author = new Y.Doc();
    const parts = inParts(bigChange(author, 1_200 * KIB, "z"));

    sendChange(room, parts);

    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "too-large" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
    expect(await settled(room)).toBe("");
  });

  it("are dropped and refused as timed out when the next part never comes, and free what they held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const room = await boardRoom("idle");
    const author = new Y.Doc();
    const [first] = inParts(bigChange(author, 30 * KIB, "i"), 10 * KIB);

    room.send(first, "copy-1", { id: "c", index: 0, count: 3 });
    expect(room.state.appChangeStaging.used()).toBe(first.length);
    await vi.advanceTimersByTimeAsync(STAGED_CHANGE_IDLE_MS);

    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "timed-out" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
    vi.useRealTimers();
    expect(await settled(room)).toBe("");
  });

  it("free what they held when the client disconnects", async () => {
    const room = await boardRoom("gone");
    const author = new Y.Doc();
    const [first] = inParts(bigChange(author, 20 * KIB, "g"), 10 * KIB);

    room.send(first, "copy-1", { id: "c", index: 0, count: 2 });
    room.disconnect();

    expect(room.state.appChangeStaging.used()).toBe(0);
  });

  it("are refused as busy when every socket together holds the most the server stages", async () => {
    const room = await boardRoom("busy", createStagingBudget(15 * KIB));
    const author = new Y.Doc();
    const parts = inParts(bigChange(author, 20 * KIB, "b"), 10 * KIB);

    sendChange(room, parts);

    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "queue-full" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
    expect(await settled(room)).toBe("");
  });
});

describe("app changes over random histories, through the real handler and worker", () => {
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
  const captured = (doc: Y.Doc, change: () => void) => {
    const before = Y.encodeStateVector(doc);
    change();
    return Y.encodeStateAsUpdate(doc, before);
  };
  const randomEdit = (doc: Y.Doc, random: () => number, bigChance: number) =>
    captured(doc, () => {
      const big = random() < bigChance;
      const text = doc.getText("t");
      doc.transact(() => {
        const kind = random();
        if (kind < 0.5) text.insert(pick(random, text.length + 1), "w".repeat(big ? 200 * KIB + pick(random, 200 * KIB) : 1 + pick(random, 40)));
        else if (kind < 0.7 && text.length > 0) {
          const at = pick(random, text.length);
          text.delete(at, Math.min(text.length - at, 1 + pick(random, 300)));
        } else {
          doc.getArray<string>("a").push([`${kind}`.padEnd(big ? 150 * KIB : 16, "x")]);
          doc.getMap<number>("m").set(`k${pick(random, 5)}`, kind);
        }
      });
    });

  it("keep every change whole or out, and leave the server equal to the client when nothing is refused", async () => {
    let matched = 0;
    let staged = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      const random = seeded(seed);
      const room = await boardRoom(`history-${seed}`);
      const client = new Y.Doc();
      const peers = [new Y.Doc(), new Y.Doc()];
      const changes: Uint8Array[] = [];
      for (let round = 0; round < 3 + pick(random, 4); round += 1) {
        const peer = peers[pick(random, peers.length)];
        const update = randomEdit(peer, random, 0);
        peers.forEach((other) => other !== peer && Y.applyUpdate(other, update));
        Y.applyUpdate(client, update);
        room.send(update, `peer-${round}`);
      }
      const peerOnly = randomEdit(peers[0], random, 0.5);
      Y.applyUpdate(client, peerOnly);
      changes.push(peerOnly);
      for (let round = 0; round < 2 + pick(random, 4); round += 1) changes.push(randomEdit(client, random, 0.3));
      const resendFrom = Y.encodeStateVector(client);
      for (let round = 0; round < 2; round += 1) randomEdit(client, random, 0.4);
      changes.push(Y.encodeStateAsUpdate(client, resendFrom));

      changes.forEach((change, index) => {
        if (change.length <= PART_BYTES) room.send(change, `client-${index}`);
        else {
          staged += 1;
          sendChange(room, inParts(change), `change-${index}`, `client-${index}`);
        }
      });
      const { doc: server } = await room.joinDocument();
      const saved = Y.snapshot(server);
      const vector = Y.decodeStateVector(Y.encodeStateVector(server));
      for (const change of changes) {
        const { from, to } = Y.parseUpdateMeta(change);
        const whole = Y.snapshotContainsUpdate(saved, change);
        const none = [...to.keys()].every((clientId) => (vector.get(clientId) ?? 0) <= (from.get(clientId) ?? 0));
        expect({ seed, wholeOrOut: whole || none }).toEqual({ seed, wholeOrOut: true });
      }
      if (room.refused.length === 0) {
        matched += 1;
        expect({ seed, text: server.getText("t").toString(), list: server.getArray("a").toJSON() }).toEqual({
          seed,
          text: client.getText("t").toString(),
          list: client.getArray("a").toJSON(),
        });
      }
    }
    expect(matched).toBeGreaterThan(3);
    expect(staged).toBeGreaterThan(3);
  }, 120_000);
});
