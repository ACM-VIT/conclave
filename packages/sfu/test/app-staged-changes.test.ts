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

const refusalsIn = (inbox: Array<{ event: string; payload: unknown }>) =>
  inbox.filter(({ event }) => event === "apps:yjs:refused").map(({ payload }) => (payload as { reason: string }).reason);

describe("app changes sent in parts", () => {
  it.each(["reseat", "promote"] as const)("preserves a staged upload when an old locked edit is refused after %s", async (changeSeat) => {
    const room = await boardRoom(changeSeat);
    expect(await room.lock()).toMatchObject({ success: true });
    room.demote();

    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    vi.spyOn(room.room.apps.executor, "changesNothing").mockReturnValueOnce(pending);
    const old = room.acknowledged({ update: bigChange(new Y.Doc(), 64, "x") }, "old");
    room[changeSeat]();
    if (changeSeat === "reseat") await room.syncFrom(new Y.Doc());
    const parts = inParts(bigChange(new Y.Doc(), 1024, "y"), 768);
    const part = { id: "replacement", count: parts.length };
    await room.acknowledged({ update: parts[0], part: { ...part, index: 0 } }, "replacement");

    finish(false);
    await old;
    await room.acknowledged({ update: parts[1], part: { ...part, index: 1 } }, "replacement");

    expect(await settled(room)).toBe("y".repeat(1024));
    expect(room.refused).toEqual(changeSeat === "reseat" ? [] : [{ appId: "board", replicaId: "old", reason: "locked" }]);
  });

  it.each(["old", undefined])("preserves a staged upload when an earlier unsynced edit is refused (%s)", async (replicaId) => {
    const room = await boardRoom("late-sync");
    const peer = await room.peer({ syncs: false });
    const blanks = () => peer.states().filter((app) => app === null);
    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    vi.spyOn(room.room.apps.executor, "changesNothing").mockReturnValueOnce(pending);
    const old = peer.acknowledged(bigChange(new Y.Doc(), 64, "x"), replicaId);
    await peer.settle();
    const parts = inParts(bigChange(new Y.Doc(), 1024, "y"), 768);
    const part = { id: "new", count: parts.length };
    await peer.acknowledged(parts[0], "new", { ...part, index: 0 });

    finish(false);
    await old;
    expect(blanks()).toHaveLength(0);
    await peer.acknowledged(parts[1], "new", { ...part, index: 1 });

    expect(await settled(room)).toBe("y".repeat(1024));
    expect(refusalsIn(peer.inbox)).toEqual(replicaId ? ["not-synced"] : []);
    expect(blanks()).toHaveLength(replicaId ? 0 : 1);
  });

  it("refreshes a promoted legacy writer after refusing its earlier locked edit", async () => {
    const room = await boardRoom("legacy-promotion");
    expect(await room.lock()).toMatchObject({ success: true });
    room.demote();
    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    vi.spyOn(room.room.apps.executor, "changesNothing").mockReturnValueOnce(pending);
    const old = room.acknowledged({ update: bigChange(new Y.Doc(), 64, "x") });

    room.promote();
    expect(room.inbox.some(({ event, payload }) => event === "apps:state" && (payload as { activeAppId: string | null }).activeAppId === null)).toBe(false);
    finish(false);

    const { inbox } = await old;
    expect(inbox.some(({ event, payload }) => event === "apps:state" && (payload as { activeAppId: string | null }).activeAppId === null)).toBe(true);
  });

  it.each(["before", "after"] as const)("refreshes the legacy copy when the stage locks %s the refusal", async (when) => {
    const room = await boardRoom("lock-staged-refresh");
    const peer = await room.peer({ syncs: false });
    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    vi.spyOn(room.room.apps.executor, "changesNothing").mockReturnValueOnce(pending);
    const old = peer.acknowledged(bigChange(new Y.Doc(), 64, "x"));
    await peer.settle();
    const parts = inParts(bigChange(new Y.Doc(), 1024, "y"), 768);
    await peer.acknowledged(parts[0], "new", { id: "new", count: parts.length, index: 0 });

    if (when === "before") expect(await room.lock()).toMatchObject({ success: true });
    finish(false);
    await old;
    if (when === "after") {
      expect(peer.states()).not.toContain(null);
      expect(await room.lock()).toMatchObject({ success: true });
    }

    expect(peer.states().filter((app) => app === null)).toHaveLength(1);
    expect(await settled(room)).toBe("");
  });

  it("refreshes the legacy copy after an assembled upload commits across an unlock", async () => {
    const room = await boardRoom("unlock-committing-refresh");
    expect(await room.lock()).toMatchObject({ success: true });
    room.demote();
    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const { executor } = room.room.apps;
    vi.spyOn(executor, "changesNothing").mockReturnValueOnce(pending);
    const old = room.acknowledged({ update: bigChange(new Y.Doc(), 64, "x") });
    room.promote();
    const parts = inParts(bigChange(new Y.Doc(), 1024, "y"), 768);
    const part = { id: "new", count: parts.length };
    await room.acknowledged({ update: parts[0], part: { ...part, index: 0 } }, "new");
    finish(false);
    await old;

    const write = executor.write.bind(executor);
    let started = () => {};
    let release = () => {};
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(executor, "write").mockImplementationOnce(async (...args) => {
      started();
      await paused;
      return write(...args);
    });
    const upload = room.acknowledged({ update: parts[1], part: { ...part, index: 1 } }, "new");
    const blanks = () => room.inbox.filter(({ event, payload }) => event === "apps:state" && (payload as { activeAppId: string | null }).activeAppId === null);
    await entering;
    try {
      expect(await room.lock(false)).toMatchObject({ success: true });
      expect(blanks()).toHaveLength(0);
    } finally {
      release();
    }

    expect((await upload).receipt).toEqual({ committed: true });
    expect(blanks()).toHaveLength(1);
    await vi.waitFor(async () => expect(await settled(room)).toBe("y".repeat(1024)));
  });

  it("ignores a pending refusal after the same app is closed and presented again", async () => {
    const room = await boardRoom("reopened-before-refusal");
    const peer = await room.peer({ syncs: false });
    let finish = (_unchanged: boolean) => {};
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    vi.spyOn(room.room.apps.executor, "changesNothing").mockReturnValueOnce(pending);
    const old = peer.acknowledged(bigChange(new Y.Doc(), 64, "x"));

    expect(await room.close()).toMatchObject({ success: true });
    expect(await room.present("board")).toMatchObject({ success: true });
    const states = peer.states();
    finish(false);
    await old;

    expect(peer.states()).toEqual(states);
  });

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
    const viewer = await room.peer({ declares: true });
    const author = new Y.Doc();
    const change = bigChange(author, 600 * KIB, "q");

    sendChange(room, inParts(change));
    const after = await settled(room);

    expect(after).toBe(author.getText("t").toString());
    expect(room.refused).toEqual([]);
    expect(viewer.updates()).toEqual([change]);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, viewer.updates()[0]);
    expect(copy.getText("t").toString()).toBe(after);
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

  it("stay pinned to their document when the socket joins another room, so the next part commits nowhere and frees them", async () => {
    const room = await boardRoom("switch");
    const parts = partsOf20Kib("r");

    sendRange(room, parts, "c", "copy-1", 0, 1);
    expect(room.state.appChangeStaging.used()).toBe(parts[0].length);
    await room.moveTo("switch-elsewhere");
    sendRange(room, parts, "c", "copy-1", 1);

    expect(await settled(room)).toBe("");
    expect(room.refused).toEqual([{ appId: "board", replicaId: "copy-1", reason: "interrupted" }]);
    expect(room.state.appChangeStaging.used()).toBe(0);
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
    [...room.state.rooms.values()].find((candidate) => candidate.id === "old-watch")!.apps.discard("board");
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

  it("go whole to every receiver that can take one, and make a native client that cannot reload the app", async () => {
    const room = await boardRoom("routing");
    const newWeb = await room.peer({ declares: true });
    const oldWeb = await room.peer();
    const newNative = await room.peer({ encoding: "base64", declares: true });
    const build63 = await room.peer({ encoding: "base64" });
    const notSynced = await room.peer({ syncs: false });
    const author = new Y.Doc();
    const small = edit(author, (text) => text.insert(0, "small"));
    const large = bigChange(author, 300 * KIB, "w");

    room.send(small, "copy-1");
    sendChange(room, inParts(large), "large", "copy-2");
    await settled(room);

    for (const receiver of [newWeb, oldWeb, newNative, notSynced]) {
      expect(receiver.updates()).toEqual([small, large]);
      expect(receiver.states()).toEqual([]);
    }
    expect(build63.updates()).toEqual([small]);
    expect(build63.states()).toEqual([null, "board"]);
    expect(room.inbox.filter(({ event }) => event === "apps:yjs:update" || event === "apps:state")).toEqual(
      [small, large].map((update) => ({ event: "apps:yjs:update", payload: { appId: "board", update } })),
    );
  });

  it("are not relayed again when a resend changes nothing, so build 63 reloads once", async () => {
    const room = await boardRoom("replay");
    const web = await room.peer({ declares: true });
    const build63 = await room.peer({ encoding: "base64" });
    const author = new Y.Doc();
    const small = edit(author, (text) => text.insert(0, "small"));
    const large = bigChange(author, 300 * KIB, "r");

    room.send(small, "copy-1");
    room.send(small, "copy-2");
    sendChange(room, inParts(large), "first", "copy-3");
    sendChange(room, inParts(large), "again", "copy-4");
    await settled(room);

    expect(web.updates()).toEqual([small, large]);
    expect(build63.updates()).toEqual([small]);
    expect(build63.states()).toEqual([null, "board"]);
    expect(room.refused).toEqual([]);
  });

  it("never reach a socket in another meeting, even one whose room id is the victim's id plus a suffix", async () => {
    const victim = await boardRoom("victim");
    const stranger = victim.strangerIn("victim:whole-changes");
    const author = new Y.Doc();

    sendChange(victim, inParts(bigChange(author, 300 * KIB, "v")));
    victim.send(edit(author, (text) => text.insert(0, "small")), "copy-2");
    await settled(victim);

    expect(stranger.inbox).toEqual([]);
  });

  it("stop reaching a socket that moved rooms, even when its sync answer landed during the move", async () => {
    const room = await boardRoom("mid-move");
    const stayer = await room.peer({ declares: true });
    const answer = room.requestSync(new Y.Doc(), true, true);
    room.beginMove();
    await answer;
    await room.finishMove("mid-move-elsewhere");
    const heardBefore = room.inbox.length;
    const author = new Y.Doc();

    inParts(bigChange(author, 300 * KIB, "m")).forEach((part, index, parts) => stayer.send(part, "stayer", { id: "s", index, count: parts.length }));
    stayer.send(edit(author, (text) => text.insert(0, "small")), "stayer");
    await stayer.settle();

    expect(room.inbox.slice(heardBefore)).toEqual([]);
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

  it("are dropped when the client sends a list of whole changes before the last part, and the next part is refused", async () => {
    const room = await boardRoom("abandoned-for-a-list");
    const author = new Y.Doc();
    const [first, second] = inParts(bigChange(author, 20 * KIB, "a"), 10 * KIB);
    const other = new Y.Doc();

    room.send(first, "copy-1", { id: "c", index: 0, count: 2 });
    room.sendList([edit(other, (text) => text.insert(0, "listed"))], "copy-2");
    expect(room.state.appChangeStaging.used()).toBe(0);
    room.send(second, "copy-1", { id: "c", index: 1, count: 2 });

    expect(await settled(room)).toBe("listed");
    expect(room.refused.map(({ replicaId, reason }) => `${replicaId} ${reason}`)).toEqual(["copy-1 interrupted"]);
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

const LIST_HISTORIES = Number(process.env.APP_LIST_HISTORIES ?? "2");
const LIST_FIRST_SEED = Number(process.env.APP_LIST_FIRST_SEED ?? "1");

describe("app changes sent as a list", () => {
  const TEXT_CLIENT = 0xffffffff;
  const writeVarUint = (bytes: number[], value: number) => {
    let rest = value;
    while (rest > 0x7f) {
      bytes.push(0x80 | (rest & 0x7f));
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  };
  const splitEveryOther = (from: number, deletions: number) => {
    const bytes: number[] = [];
    writeVarUint(bytes, 0);
    writeVarUint(bytes, 1);
    writeVarUint(bytes, TEXT_CLIENT);
    writeVarUint(bytes, deletions);
    for (let step = 0; step < deletions; step += 1) {
      writeVarUint(bytes, from + step * 2);
      writeVarUint(bytes, 1);
    }
    return Uint8Array.from(bytes);
  };
  const encodedBytes = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc).length;
  const fits = (model: Y.Doc, update: Uint8Array) => {
    const trial = new Y.Doc();
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(model));
    Y.applyUpdate(trial, update);
    return trial.store.pendingStructs === null && trial.store.pendingDs === null && encodedBytes(trial) <= MAX_DOC_BYTES;
  };
  const contentOf = (doc: Y.Doc) => ({ t: doc.getText("t").toString(), m: doc.getMap("m").toJSON() });
  const serverCopy = async (room: Awaited<ReturnType<typeof boardRoom>>) => (await room.joinDocument()).doc;

  it("are offered to new clients in the sync reply", async () => {
    const room = await boardRoom("list-offer");

    expect(await room.syncFrom(new Y.Doc())).toMatchObject({ takesUpdateLists: true });
  });

  it("apply one change at a time in order, so one that fits lands and is relayed while the one that does not, and what follows it from the same copy, are refused", async () => {
    const room = await boardRoom("list-near-limit");
    const author = new Y.Doc();
    fill(room, author, 4, 225 * KIB);
    await settled(room);
    const relayedBefore = room.relayed.length;
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(author));
    const fitting = edit(author, (text) => text.insert(0, "a".repeat(20 * KIB)));
    const tooBig = edit(author, (text) => text.insert(text.length, "b".repeat(200 * KIB)));
    const after = (() => {
      const before = Y.encodeStateVector(author);
      author.getMap("m").set("c", "c".repeat(10 * KIB));
      return Y.encodeStateAsUpdate(author, before);
    })();
    const fromAnotherCopy = (() => {
      const before = Y.encodeStateVector(other);
      other.getMap("m").set("d", "d".repeat(10 * KIB));
      return Y.encodeStateAsUpdate(other, before);
    })();

    room.sendList([fitting, tooBig, after, fromAnotherCopy], "copy-list");
    const saved = await serverCopy(room);

    expect(saved.getText("t").toString().startsWith("a".repeat(20 * KIB))).toBe(true);
    expect(saved.getText("t").toString().includes("b")).toBe(false);
    expect(saved.getMap("m").get("c")).toBeUndefined();
    expect(saved.getMap("m").get("d")).toBe("d".repeat(10 * KIB));
    expect(room.refused.map(({ reason }) => reason)).toEqual(["too-large"]);
    expect(room.relayed.slice(relayedBefore)).toEqual([fitting, fromAnotherCopy]);
  }, 30_000);

  it("never lose a change that would fit on its own, over random lists near the limit with deletions that split a long text", async () => {
    let refused = 0;
    let landed = 0;
    for (let seed = LIST_FIRST_SEED; seed < LIST_FIRST_SEED + LIST_HISTORIES; seed += 1) {
      const random = (() => {
        let state = seed >>> 0;
        return () => {
          state = (state + 0x6d2b79f5) >>> 0;
          let mixed = state;
          mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
          mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
          return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
        };
      })();
      const pick = (below: number) => Math.floor(random() * below);
      const room = await boardRoom(`list-history-${seed}`);
      const seedDoc = new Y.Doc();
      seedDoc.clientID = TEXT_CLIENT;
      const length = 80_000 + pick(40_000);
      seedDoc.getText("t").insert(0, "x".repeat(length));
      const model = new Y.Doc();
      const seeded = Y.encodeStateAsUpdate(seedDoc);
      room.send(seeded, `seed-${seed}`);
      Y.applyUpdate(model, seeded);
      let author = new Y.Doc();
      Y.applyUpdate(author, Y.encodeStateAsUpdate(model));
      for (let round = 0; round < 6; round += 1) {
        const list: Uint8Array[] = [];
        let bytes = 0;
        for (let index = 0, count = 1 + pick(5); index < count; index += 1) {
          const kind = random();
          let update: Uint8Array;
          if (kind < 0.4) {
            const from = pick(length / 2);
            update = splitEveryOther(from, Math.max(1, Math.floor(Math.min(length - from, 2_000 + pick(40_000)) / 2)));
            Y.applyUpdate(author, update);
          } else if (kind < 0.7) {
            update = edit(author, (text) => text.insert(pick(text.length + 1), "p".repeat(1 + pick(120 * KIB))));
          } else {
            const before = Y.encodeStateVector(author);
            author.getMap("m").set(`k${round}-${index}`, "v".repeat(1 + pick(80 * KIB)));
            update = Y.encodeStateAsUpdate(author, before);
          }
          if (bytes + update.length > PART_BYTES) break;
          bytes += update.length;
          list.push(update);
        }
        const replicaId = `copy-${seed}-${round}`;
        let refusedInRound = false;
        for (const update of list) {
          if (fits(model, update)) {
            Y.applyUpdate(model, update);
            landed += 1;
          } else {
            refusedInRound = true;
          }
        }
        if (list.length > 0) room.sendList(list, replicaId);
        const saved = await serverCopy(room);
        expect({ seed, round, content: contentOf(saved) }).toEqual({ seed, round, content: contentOf(model) });
        expect({ seed, round, refused: room.refused.some((refusal) => refusal.replicaId === replicaId) }).toEqual({ seed, round, refused: refusedInRound });
        if (refusedInRound) {
          refused += 1;
          author = new Y.Doc();
          Y.applyUpdate(author, Y.encodeStateAsUpdate(saved));
        }
      }
    }
    expect(refused).toBeGreaterThanOrEqual(Math.ceil(LIST_HISTORIES / 2));
    expect(landed).toBeGreaterThanOrEqual(LIST_HISTORIES * 3);
  }, Math.max(60_000, LIST_HISTORIES * 30_000));

  it("take one rate-limit token for the whole list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const room = await boardRoom("list-tokens");
    const author = new Y.Doc();
    const small = () => edit(author, (text) => text.insert(text.length, "t"));

    for (let index = 0; index < 30; index += 1) room.sendList([small(), small(), small()], "copy-tokens");
    for (let index = 0; index < 30; index += 1) room.send(small(), "copy-tokens");
    expect(await settled(room)).toHaveLength(30 * 3 + 30);
    expect(room.refused).toEqual([]);

    room.send(small(), "copy-tokens");
    await settled(room);
    expect(room.refused.map(({ reason }) => reason)).toEqual(["rate-limited"]);
  }, 30_000);

  it("are refused whole when the list is malformed or bigger than one update may be, with nothing applied or relayed", async () => {
    const room = await boardRoom("list-malformed");
    const author = new Y.Doc();
    const small = () => edit(author, (text) => text.insert(text.length, "m"));
    const relayedBefore = room.relayed.length;

    room.sendList([], "copy-empty");
    room.sendList("not a list", "copy-string");
    room.sendList(Array.from({ length: 65 }, small), "copy-too-many");
    room.sendList([small(), 5], "copy-not-binary");
    room.sendList([small(), new Uint8Array(0)], "copy-empty-item");
    room.sendList([edit(author, (text) => text.insert(0, "x".repeat(200 * KIB))), edit(author, (text) => text.insert(0, "y".repeat(100 * KIB)))], "copy-over-cap");

    expect(await settled(room)).toBe("");
    expect(room.refused.map(({ replicaId, reason }) => `${replicaId} ${reason}`)).toEqual([
      "copy-empty invalid",
      "copy-string invalid",
      "copy-too-many invalid",
      "copy-not-binary invalid",
      "copy-empty-item invalid",
      "copy-over-cap too-large",
    ]);
    expect(room.relayed.slice(relayedBefore)).toEqual([]);
  }, 30_000);
});

describe("app uploads", () => {
  it("are acknowledged once committed, and a list once every change in it is", async () => {
    const room = await boardRoom("ack-commit");
    const author = new Y.Doc();
    const relayedBefore = room.relayed.length;

    const one = edit(author, (text) => text.insert(0, "one"));
    const single = await room.acknowledged({ update: one }, "copy-a");
    expect(single.receipt).toEqual({ committed: true });
    expect(single.relayed).toBe(relayedBefore + 1);
    const alreadySaved = await room.acknowledged({ update: one }, "copy-a");
    expect(alreadySaved.receipt).toEqual({ committed: true });
    expect(alreadySaved.relayed).toBe(single.relayed);
    const list = await room.acknowledged({ updates: [edit(author, (text) => text.insert(0, "two")), edit(author, (text) => text.insert(0, "three"))] }, "copy-a");
    expect(list.receipt).toEqual({ committed: true });
    expect(list.relayed).toBe(relayedBefore + 3);
    expect(await settled(room)).toBe("threetwoone");
  });

  it("are acknowledged only after the author is told one was refused", async () => {
    const room = await boardRoom("ack-refused");
    const author = new Y.Doc();
    fill(room, author, 4, 230 * KIB);

    const refused = await room.acknowledged({ updates: [edit(author, (text) => text.insert(0, "f")), edit(author, (text) => text.insert(0, "b".repeat(200 * KIB)))] }, "copy-r");
    expect(refused.receipt).toBeUndefined();
    expect(refusalsIn(refused.inbox)).toEqual(["too-large"]);
    const dropped = await room.acknowledged({ update: new Uint8Array(0) }, "copy-e");
    expect(dropped.receipt).toBeUndefined();
    expect(refusalsIn(dropped.inbox)).toEqual(["too-large", "invalid"]);
  }, 30_000);

  it("are acknowledged when the server drops them before the document, and a part as soon as it is staged", async () => {
    const room = await boardRoom("ack-dropped");
    const author = new Y.Doc();
    await room.close();
    const notOpen = await room.acknowledged({ update: edit(author, (text) => text.insert(0, "x")) }, "copy-n");
    expect(notOpen.receipt).toBeUndefined();
    expect(refusalsIn(notOpen.inbox)).toEqual(["not-live"]);
    await room.open();

    const parts = inParts(bigChange(new Y.Doc(), 20 * KIB, "s"), 10 * KIB);
    const relayedBefore = room.relayed.length;
    const first = await room.acknowledged({ update: parts[0], part: { id: "c", index: 0, count: parts.length } }, "copy-p");
    expect(first.receipt).toBeUndefined();
    expect(room.state.appChangeStaging.used()).toBe(parts[0].length);
    for (const [index, part] of parts.slice(1, -1).entries()) {
      const intermediate = await room.acknowledged({ update: part, part: { id: "c", index: index + 1, count: parts.length } }, "copy-p");
      expect(intermediate.receipt).toBeUndefined();
    }
    const last = await room.acknowledged({ update: parts.at(-1)!, part: { id: "c", index: parts.length - 1, count: parts.length } }, "copy-p");
    expect(last.receipt).toEqual({ committed: true });
    expect(last.relayed).toBe(relayedBefore + 1);
    expect(room.refused.map(({ reason }) => reason)).toEqual(["not-live"]);
  });
});

describe("app state answers", () => {
  it("does not close a new room whose revision happens to match the old room", async () => {
    const room = await boardRoom("new-room");
    const stage = await room.getState() as { revision: number };
    expect(await room.close({ expectedRevision: stage.revision, expectedRoomId: "old-room" })).toMatchObject({
      success: false, code: "stale_revision",
    });
    expect(await room.getState()).toMatchObject({ activeAppId: "board" });
    expect(await room.close({ expectedRevision: stage.revision, expectedRoomId: "new-room" })).toEqual({
      success: true, revision: stage.revision + 1,
    });
  });

  it("say a socket is not in a room yet instead of saying no app is open", async () => {
    const room = await boardRoom("state-answer");
    expect(await room.getState()).toMatchObject({ activeAppId: "board", locked: false });

    room.leave();

    expect(await room.getState()).toMatchObject({ activeAppId: null, locked: false, notInRoom: true });
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
