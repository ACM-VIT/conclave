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

const changeIn = (author: Y.Doc, parts: number, size: number, mark: string) =>
  Array.from({ length: parts }, (_, index) => edit(author, (text) => text.insert(text.length, `${mark}${index}`.padEnd(size, mark))));

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

    sendChange(room, changeIn(author, 4, 100 * KIB, "p"));
    const after = await settled(room);

    expect(after).toBe(before);
    expect(after).not.toContain("p0");
    expect(room.relayed).toHaveLength(relayedBefore);
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "too-large" }]);
  });

  it("are applied whole when they fit, and relayed in order so a peer applies them too", async () => {
    const room = await boardRoom("fits");
    const author = new Y.Doc();
    const parts = changeIn(author, 4, 100 * KIB, "q");

    sendChange(room, parts);
    const after = await settled(room);

    expect(after).toBe(author.getText("t").toString());
    expect(room.refused).toEqual([]);
    expect(room.relayed).toEqual(parts);
    const peer = new Y.Doc();
    room.relayed.forEach((update) => Y.applyUpdate(peer, update));
    expect(peer.getText("t").toString()).toBe(after);
  });

  it("are refused as invalid when a part arrives out of order or names another change, with nothing applied", async () => {
    const room = await boardRoom("order");
    const author = new Y.Doc();
    const [first, second, third] = changeIn(author, 3, 10 * KIB, "o");

    room.send(first, "copy-1", { id: "c", index: 0, count: 3 });
    room.send(third, "copy-1", { id: "c", index: 2, count: 3 });
    room.send(second, "copy-2", { id: "d", index: 1, count: 3 });
    room.send(second, "copy-3", { id: "e", index: 0, count: 1 });

    expect(await settled(room)).toBe("");
    expect(room.refused.map((refusal) => [refusal.replicaId, refusal.reason])).toEqual([
      ["copy-1", "invalid"],
      ["copy-2", "invalid"],
      ["copy-3", "invalid"],
    ]);
  });

  it("are dropped when the client sends a whole update before the last part", async () => {
    const room = await boardRoom("abandoned");
    const author = new Y.Doc();
    const [first] = changeIn(author, 2, 10 * KIB, "a");
    const other = new Y.Doc();

    room.send(first, "copy-1", { id: "c", index: 0, count: 2 });
    room.send(edit(other, (text) => text.insert(0, "whole")), "copy-2");

    expect(await settled(room)).toBe("whole");
    expect(room.state.appChangeStaging.used()).toBe(0);
  });

  it("are refused while staging when the change alone is bigger than a document can be", async () => {
    const room = await boardRoom("oversized");
    const author = new Y.Doc();
    const parts = changeIn(author, 5, 250 * KIB, "z");

    sendChange(room, parts);

    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "too-large" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
    expect(await settled(room)).toBe("");
  });

  it("are dropped and refused as timed out when the next part never comes, and free what they held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const room = await boardRoom("idle");
    const author = new Y.Doc();
    const [first] = changeIn(author, 3, 10 * KIB, "i");

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
    const [first] = changeIn(author, 2, 10 * KIB, "g");

    room.send(first, "copy-1", { id: "c", index: 0, count: 2 });
    room.disconnect();

    expect(room.state.appChangeStaging.used()).toBe(0);
  });

  it("are refused as busy when every socket together holds the most the server stages", async () => {
    const room = await boardRoom("busy", createStagingBudget(15 * KIB));
    const author = new Y.Doc();
    const parts = changeIn(author, 2, 10 * KIB, "b");

    sendChange(room, parts);

    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "queue-full" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
    expect(await settled(room)).toBe("");
  });
});
