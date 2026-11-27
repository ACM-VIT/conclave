import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { AppsState } from "../types.js";
import { makeRoom, pageOf, writePage } from "./support/appsRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Joined = ReturnType<ReturnType<typeof makeRoom>["join"]>;

const stagesSeenBy = (client: Joined): (string | null)[] =>
  client.received
    .filter((sent) => sent.event === "apps:state")
    .map((sent) => (sent.payload as AppsState).activeAppId);

const refusalsOf = (client: Joined): string[] =>
  client.received
    .filter((sent) => sent.event === "apps:yjs:refused")
    .map((sent) => (sent.payload as { reason: string }).reason);

const savedBoard = () => {
  const room = makeRoom();
  const hostDoc = new Y.Doc();
  hostDoc.clientID = 1;
  const host = room.join("host#1", "host", hostDoc);
  host.present("whiteboard");
  host.sendUpdate("whiteboard", writePage(hostDoc, ["kept-1", "kept-2"]));
  host.close(host.state().revision);
  host.present("whiteboard", host.state().revision);
  const cold = () => pageOf(room.join(`cold#${Math.random()}`, "participant").coldUpdate("whiteboard"));
  return { ...room, host, cold };
};

describe("an older client whose change the room refused", () => {
  it("starts its copy over after drawing before its first sync, then keeps its next stroke", () => {
    vi.useFakeTimers();
    const { join, cold } = savedBoard();
    const earlyDoc = new Y.Doc();
    earlyDoc.clientID = 2 ** 31;
    const early = join("early#1", "participant", earlyDoc);

    early.sendAsIs("whiteboard", writePage(earlyDoc, ["early"]));
    expect(stagesSeenBy(early)).toEqual([null]);
    vi.advanceTimersByTime(1000);
    expect(stagesSeenBy(early)).toEqual([null, "whiteboard"]);
    early.freshCopy();
    early.syncReplyInto("whiteboard");
    early.sendUpdate("whiteboard", writePage(early.doc, ["after"]));

    expect(early.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(cold()).toEqual(["after", "kept-1", "kept-2"]);
  });

  it("starts its copy over after resyncing a board the host cleared while it was away", () => {
    vi.useFakeTimers();
    const { join, host, cold } = savedBoard();
    const native = join("native#1", "participant");
    native.syncReplyInto("whiteboard");
    native.sendUpdate("whiteboard", writePage(native.doc, ["mine"]));
    host.discard("whiteboard", host.state().revision);
    host.present("whiteboard", host.state().revision);

    native.resync("whiteboard");
    expect(stagesSeenBy(native)).toEqual([null]);
    vi.advanceTimersByTime(1000);
    expect(stagesSeenBy(native)).toEqual([null, "whiteboard"]);
    native.freshCopy();
    native.syncReplyInto("whiteboard");
    native.sendUpdate("whiteboard", writePage(native.doc, ["fresh"]));

    expect(cold()).toEqual(["fresh"]);
  });

  it("starts its copy over once, however many of its changes arrive before it syncs again", () => {
    vi.useFakeTimers();
    const { join } = savedBoard();
    const early = join("early#1", "participant");

    early.sendAsIs("whiteboard", writePage(early.doc, ["early-1"]));
    early.sendAsIs("whiteboard", writePage(early.doc, ["early-2"]));
    vi.advanceTimersByTime(1000);
    early.sendAsIs("whiteboard", writePage(early.doc, ["early-3"]));
    vi.advanceTimersByTime(1000);

    expect(stagesSeenBy(early)).toEqual([null, "whiteboard"]);
  });

  it("is restarted again until it syncs a fresh copy, at most three times", () => {
    vi.useFakeTimers();
    const { join } = savedBoard();
    const early = join("early#1", "participant");

    early.sendAsIs("whiteboard", writePage(early.doc, ["early"]));
    vi.advanceTimersByTime(4800);
    expect(stagesSeenBy(early)).toEqual([null, "whiteboard", null]);
    vi.advanceTimersByTime(60_000);
    expect(stagesSeenBy(early)).toEqual([null, "whiteboard", null, "whiteboard", null, "whiteboard"]);

    const synced = join("synced#1", "participant");
    synced.sendAsIs("whiteboard", writePage(synced.doc, ["early"]));
    vi.advanceTimersByTime(1000);
    synced.freshCopy();
    synced.syncReplyInto("whiteboard");
    vi.advanceTimersByTime(60_000);
    expect(stagesSeenBy(synced)).toEqual([null, "whiteboard"]);
  });

  it("gets the room's copy for its new copy's empty update when both stages reach it at once", () => {
    vi.useFakeTimers();
    const { join, host } = savedBoard();
    const tab = join("tab#1", "participant");
    tab.syncReplyInto("whiteboard");
    host.lock(true, host.state().revision);
    tab.sendUpdate("whiteboard", writePage(tab.doc, ["while-locked"]));
    vi.advanceTimersByTime(1000);
    expect(stagesSeenBy(tab)).toEqual([null, "whiteboard"]);
    tab.received.length = 0;

    tab.freshCopy();
    tab.sendAsIs("whiteboard", Y.encodeStateAsUpdate(new Y.Doc()));

    const pushed = tab.received.filter((sent) => sent.event === "apps:yjs:update");
    expect(pushed.map((sent) => pageOf((sent.payload as { update: Uint8Array }).update))).toEqual([
      ["kept-1", "kept-2"],
    ]);
  });

  it("is sent the room's copy, with its stage left alone, for the empty update it opens a copy with", () => {
    vi.useFakeTimers();
    const { join } = savedBoard();
    const tab = join("tab#1", "participant");

    tab.sendAsIs("whiteboard", Y.encodeStateAsUpdate(new Y.Doc()));
    vi.advanceTimersByTime(1000);

    const pushed = tab.received.filter((sent) => sent.event === "apps:yjs:update");
    expect(pushed.map((sent) => pageOf((sent.payload as { update: Uint8Array }).update))).toEqual([
      ["kept-1", "kept-2"],
    ]);
    expect(stagesSeenBy(tab)).toEqual([]);
  });
});

describe("a client that names its copy", () => {
  it("is told its change was refused, and its stage is left alone", () => {
    vi.useFakeTimers();
    const { join, host } = savedBoard();
    const viewer = join("viewer#1", "participant");
    viewer.syncReplyInto("whiteboard");
    host.lock(true, host.state().revision);

    viewer.sendWithReplica("whiteboard", writePage(viewer.doc, ["while-locked"]), "copy-1");
    vi.advanceTimersByTime(1000);

    expect(refusalsOf(viewer)).toEqual(["locked"]);
    expect(stagesSeenBy(viewer)).toEqual([]);
  });

  it("cannot upload a page it drew on an empty copy before its first sync over the saved page", () => {
    const { join, cold } = savedBoard();
    const late = join("late#1", "participant");
    writePage(late.doc, ["drawn-early"]);

    const reply = late.syncReplyInto("whiteboard") as { stateVector: Uint8Array };
    late.sendWithReplica("whiteboard", Y.encodeStateAsUpdate(late.doc, reply.stateVector), "copy-1");

    expect(refusalsOf(late)).toEqual(["unseen-value"]);
    expect(late.relayed).toEqual([]);
    expect(cold()).toEqual(["kept-1", "kept-2"]);
  });
});
