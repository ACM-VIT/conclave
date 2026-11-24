import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { makeRoom } from "./support/appsRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Stroke = { id: string; points: number[] };

const strokesIn = (update: Uint8Array): Stroke[] => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getArray<Stroke>("elements").toArray();
};

const keysIn = (update: Uint8Array): string[] => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return Array.from(doc.getMap("shapes").keys()).sort();
};

const drawLongStroke = (doc: Y.Doc, send: (update: Uint8Array) => void, steps: number) => {
  const elements = doc.getArray<Stroke>("elements");
  doc.on("update", send);
  elements.push([{ id: "stroke", points: [0] }]);
  for (let step = 1; step <= steps; step += 1) {
    const points = [...elements.get(0).points, step];
    elements.delete(0, 1);
    elements.insert(0, [{ id: "stroke", points }]);
    vi.advanceTimersByTime(16);
  }
  doc.off("update", send);
  vi.advanceTimersByTime(2000);
};

const keyUpdate = (doc: Y.Doc, key: string): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  doc.getMap("shapes").set(key, true);
  return Y.encodeStateAsUpdate(doc, before);
};

describe("the room's update budget", () => {
  it.each([
    ["an older client", undefined],
    ["a client that names its copy", "copy-1"],
  ] as const)("keeps a four second stroke %s draws at pointer speed", (_, replicaId) => {
    vi.useFakeTimers();
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    const artist = join("artist#1", "participant");
    artist.syncReplyInto("whiteboard");
    const steps = 250;

    drawLongStroke(
      artist.doc,
      (update) =>
        replicaId
          ? artist.sendWithReplica("whiteboard", update, replicaId)
          : artist.sendUpdate("whiteboard", update),
      steps,
    );

    expect(artist.received.filter((sent) => sent.event === "apps:yjs:refused")).toEqual([]);
    expect(artist.received.filter((sent) => sent.event === "apps:state")).toEqual([]);
    const saved = strokesIn(join("late#1", "participant").coldUpdate("whiteboard"));
    expect(saved.map((stroke) => stroke.points.length)).toEqual([steps + 1]);
    const relayed = new Y.Doc();
    for (const sent of artist.relayed) Y.applyUpdate(relayed, (sent.payload as { update: Uint8Array }).update);
    expect(relayed.getArray<Stroke>("elements").toArray().map((stroke) => stroke.points.length)).toEqual([
      steps + 1,
    ]);
  });

  it("applies the updates it held for a socket before that socket syncs again", () => {
    vi.useFakeTimers();
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.syncReplyInto("whiteboard");
    for (let index = 0; index < 80; index += 1) host.sendUpdate("whiteboard", keyUpdate(host.doc, `k${index}`));

    const reply = host.request<{ syncMessage: Uint8Array }>("apps:yjs:sync", {
      appId: "whiteboard",
      syncMessage: Y.encodeStateVector(new Y.Doc()),
    });
    vi.advanceTimersByTime(200);

    expect(keysIn(reply.value!.syncMessage)).toHaveLength(80);
  });

  it("applies the strokes it held for a host before that host changes the stage", () => {
    vi.useFakeTimers();
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.syncReplyInto("whiteboard");
    for (let index = 0; index < 80; index += 1) host.sendUpdate("whiteboard", keyUpdate(host.doc, `k${index}`));

    host.present("watch", host.state().revision);
    vi.advanceTimersByTime(200);
    host.present("whiteboard", host.state().revision);
    vi.advanceTimersByTime(200);

    expect(keysIn(join("late#1", "participant").coldUpdate("whiteboard"))).toHaveLength(80);
  });

  it("refuses an update only once a socket's held updates pass their bound", () => {
    vi.useFakeTimers();
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    const writer = join("writer#1", "participant");
    writer.syncReplyInto("whiteboard");
    const refusals = () => writer.received.filter((sent) => sent.event === "apps:yjs:refused");
    const filler = "x".repeat(1024);
    const write = (key: string) => {
      const before = Y.encodeStateVector(writer.doc);
      writer.doc.getMap("shapes").set(key, filler);
      writer.sendWithReplica("whiteboard", Y.encodeStateAsUpdate(writer.doc, before), "copy-1");
    };

    for (let index = 0; index < 120; index += 1) write(`a${index}`);
    expect(refusals()).toEqual([]);
    for (let index = 0; index < 400; index += 1) write(`b${index}`);

    expect(refusals().map((sent) => (sent.payload as { reason: string }).reason)).toEqual(["rate-limited"]);
  });
});
