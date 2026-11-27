import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createAppDocumentPool, type AppDocumentPool } from "../server/apps/documents/pool.js";
import { inAppRoom } from "./fixtures/app-room.js";

const MAX_DOC_BYTES = 1024 * 1024;

const pools: AppDocumentPool[] = [];
const joinApp = async (id: string, appId = "board") => {
  const pool = createAppDocumentPool({ workers: 1, deadlineMs: 20_000, maxDocumentBytes: MAX_DOC_BYTES });
  pools.push(pool);
  const room = inAppRoom(pool, id, { appId, wheelFormat: appId === "wheel" ? 2 : undefined });
  await room.open();
  return room;
};

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
});

const writeVarUint = (bytes: number[], value: number) => {
  let rest = value;
  while (rest > 0x7f) {
    bytes.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
};

const singleCharacterDeletions = (client: number, clocks: number[]): Uint8Array => {
  const bytes: number[] = [];
  writeVarUint(bytes, 0);
  writeVarUint(bytes, 1);
  writeVarUint(bytes, client);
  writeVarUint(bytes, clocks.length);
  for (const clock of clocks) {
    writeVarUint(bytes, clock);
    writeVarUint(bytes, 1);
  }
  return Uint8Array.from(bytes);
};

const everyOtherClock = (from: number, to: number) => {
  const clocks: number[] = [];
  for (let clock = from; clock < to; clock += 2) clocks.push(clock);
  return clocks;
};

describe("app document size", () => {
  it("stops growing a document at the size a sync can still deliver", async () => {
    const room = await joinApp("inserts");

    const attacker = new Y.Doc();
    const text = attacker.getText("t");
    const chunk = "x".repeat(200 * 1024);
    for (let index = 0; index < 20; index += 1) {
      const before = Y.encodeStateVector(attacker);
      text.insert(text.length, chunk);
      room.send(Y.encodeStateAsUpdate(attacker, before));
    }

    const { doc, encodedBytes } = await room.joinDocument();
    expect(encodedBytes).toBeLessThanOrEqual(MAX_DOC_BYTES);
    expect(doc.getText("t").length).toBeGreaterThan(0);
  });
});

describe("app document size with deletions", () => {
  it("encodes deletions the way a Yjs client does", () => {
    const client = new Y.Doc();
    const text = client.getText("t");
    text.insert(0, "x".repeat(20));
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      for (let index = 18; index >= 0; index -= 2) text.delete(index, 1);
    });

    expect(singleCharacterDeletions(client.clientID, everyOtherClock(0, 20))).toEqual(
      Y.encodeStateAsUpdate(client, before),
    );
  });

  it("refuses deletions whose item splits would push the document past the limit", async () => {
    const room = await joinApp("deletions");
    const joined = async () => {
      const { doc, encodedBytes } = await room.joinDocument();
      return { doc, length: doc.getText("t").length, encodedBytes };
    };
    const attacker = new Y.Doc();
    attacker.clientID = 0xffffffff;
    const deletionsUpTo = (end: number) => singleCharacterDeletions(attacker.clientID, everyOtherClock(0, end));

    attacker.getText("t").insert(0, "x".repeat(120_001));
    room.send(Y.encodeStateAsUpdate(attacker));
    expect((await joined()).length).toBe(120_001);

    room.send(deletionsUpTo(40_000));
    expect((await joined()).length).toBe(100_001);
    room.send(deletionsUpTo(82_898));
    const atLimit = await joined();
    expect(atLimit.length).toBe(78_552);
    expect(atLimit.encodedBytes).toBe(MAX_DOC_BYTES);

    const oneMoreDeletion = deletionsUpTo(82_900);
    Y.applyUpdate(atLimit.doc, oneMoreDeletion);
    expect(Y.encodeStateAsUpdate(atLimit.doc).length).toBeGreaterThan(MAX_DOC_BYTES);

    room.send(oneMoreDeletion);
    const afterRefusal = await joined();
    expect(afterRefusal.length).toBe(78_552);
    expect(afterRefusal.encodedBytes).toBe(MAX_DOC_BYTES);
    expect(room.relayed).toHaveLength(3);
  }, 30_000);
});

it.each(["wheel", "board"])("echoes accepted updates to the writer only for the wheel (%s)", async (appId) => {
  const room = await joinApp(`receipt-${appId}`, appId);
  const writer = new Y.Doc();
  const entry = { id: "ada", label: "Ada" };
  writer.getArray("wheel.entries").push([entry]);
  const update = Y.encodeStateAsUpdate(writer);
  const echoes = () => room.inbox.filter(({ event }) => event === "apps:yjs:update");

  await room.acknowledged({ update });
  expect((await room.joinDocument()).doc.getArray("wheel.entries").toArray()).toEqual([entry]);
  expect(room.relayed).toEqual([update]);
  expect(echoes()).toEqual(appId === "wheel" ? [{ event: "apps:yjs:update", payload: { appId, update } }] : []);

  await room.acknowledged({ update });
  await room.acknowledged({ update: Uint8Array.of(255) });
  await room.acknowledged({ update: new Uint8Array(MAX_DOC_BYTES) });
  expect(room.relayed).toEqual([update]);
  expect(echoes()).toHaveLength(appId === "wheel" ? 1 : 0);
});
