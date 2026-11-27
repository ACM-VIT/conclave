import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { BOARD, makeWorkRooms } from "./support/appsWorkRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const UPDATE_LIMIT = 256 * 1024;
const SYNC_LIMIT = 64 * 1024;
const AWARENESS_LIMIT = 64 * 1024;

const presentedBoard = () => {
  vi.useFakeTimers();
  const rooms = makeWorkRooms();
  const host = rooms.connect("host#1", { host: true });
  host.command("open", BOARD);
  const sender = rooms.connect("sender#1");
  const viewer = rooms.connect("viewer#1");
  sender.sync();
  viewer.sync();
  return { host, sender, viewer };
};

const exactly = (bytes: number, build: (filler: number) => Uint8Array): Uint8Array => {
  let filler = bytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const built = build(filler);
    if (built.length === bytes) return built;
    filler += bytes - built.length;
  }
  throw new Error(`no payload of exactly ${bytes} bytes`);
};

const updateOf = (bytes: number): Uint8Array =>
  exactly(bytes, (filler) => {
    const doc = new Y.Doc();
    doc.clientID = 2 ** 24;
    doc.getMap("m").set("sized", "x".repeat(filler));
    return Y.encodeStateAsUpdate(doc);
  });

const stateVectorOf = (bytes: number): Uint8Array => {
  const entries = Math.floor((bytes - 2) / 5);
  const wide = bytes - 2 - entries * 5;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries);
  for (let index = 0; index < entries; index += 1) {
    encoding.writeVarUint(encoder, 2 ** 21 + index);
    encoding.writeVarUint(encoder, index < wide ? 128 : 0);
  }
  const vector = encoding.toUint8Array(encoder);
  expect(vector.length).toBe(bytes);
  expect(Y.decodeStateVector(vector).size).toBe(entries);
  return vector;
};

const awarenessOf = (bytes: number): Uint8Array =>
  exactly(bytes, (filler) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, 2 ** 22);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, JSON.stringify({ pad: "x".repeat(Math.max(0, filler)) }));
    return encoding.toUint8Array(encoder);
  });

const nativeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const ENCODINGS: [string, (bytes: Uint8Array) => unknown][] = [
  ["web binary (a Node Buffer from socket.io)", (bytes) => Buffer.from(bytes)],
  ["a Uint8Array", (bytes) => bytes],
  ["an ArrayBuffer", (bytes) => bytes.slice().buffer],
  ["a Uint16Array view", (bytes) => new Uint16Array(bytes.slice().buffer, 0, bytes.length / 2)],
  ["a number array", (bytes) => Array.from(bytes)],
  ["a JSON Buffer", (bytes) => ({ type: "Buffer", data: Array.from(bytes) })],
  ["native base64 (padded, no line breaks)", nativeBase64],
];

const BOUNDARIES = (limit: number): [string, number, boolean][] => [
  ["limit - 1", limit - 1, true],
  ["limit", limit, true],
  ["limit + 1", limit + 1, false],
];

const cases = (limit: number) =>
  ENCODINGS.flatMap(([name, encode]) =>
    BOUNDARIES(limit)
      .filter(([, bytes]) => !name.includes("Uint16Array") || bytes % 2 === 0)
      .map(([label, bytes, accepted]) => [name, label, bytes, accepted, encode] as const),
  );

describe("payload size caps count decoded bytes, whatever the wire encoding", () => {
  it("produces the same base64 as both native platforms for every padding length", () => {
    expect([1, 2, 3, 4].map((length) => nativeBase64(new Uint8Array(length).fill(0xfb)))).toEqual([
      "+w==",
      "+/s=",
      "+/v7",
      "+/v7+w==",
    ]);
  });

  it.each(cases(UPDATE_LIMIT))("an update as %s at %s (%i bytes)", (_, __, bytes, accepted, encode) => {
    const { sender, viewer } = presentedBoard();
    const update = updateOf(bytes);

    sender.sendPayload(encode(update));

    const refused = sender.received.filter((entry) => entry.event === "apps:yjs:refused");
    const relayed = viewer.received.filter((entry) => entry.event === "apps:yjs:update" && !entry.direct);
    if (accepted) {
      expect(refused).toEqual([]);
      expect(relayed.map((entry) => (entry.payload as { update: Uint8Array }).update.length)).toEqual([bytes]);
    } else {
      expect(refused.map((entry) => (entry.payload as { reason: string }).reason)).toEqual(["too-large"]);
      expect(relayed).toEqual([]);
    }
  });

  it.each(cases(SYNC_LIMIT))("a sync as %s at %s (%i bytes)", (_, __, bytes, accepted, encode) => {
    const { viewer } = presentedBoard();

    const record = viewer.syncPayload(encode(stateVectorOf(bytes)));

    if (accepted) expect(record.reply).toHaveProperty("syncMessage");
    else expect(record.reply).toEqual({ error: "Sync payload too large" });
  });

  it.each(cases(AWARENESS_LIMIT))("presence as %s at %s (%i bytes)", (_, __, bytes, accepted, encode) => {
    const { sender, viewer } = presentedBoard();

    sender.awarenessPayload(encode(awarenessOf(bytes)));

    const relayed = viewer.received.filter((entry) => entry.event === "apps:awareness");
    expect(relayed).toHaveLength(accepted ? 1 : 0);
  });

  it.each([
    ["one pad character", 41],
    ["two pad characters", 40],
    ["two pad characters at the update limit", UPDATE_LIMIT],
  ])("refuses base64 missing %s as invalid", (_, bytes) => {
    const { sender } = presentedBoard();
    const unpadded = nativeBase64(updateOf(bytes)).replace(/=+$/, "");
    expect(unpadded.length % 4).not.toBe(0);

    sender.sendPayload(unpadded);

    const refused = sender.received.filter((entry) => entry.event === "apps:yjs:refused");
    expect(refused.map((entry) => (entry.payload as { reason: string }).reason)).toEqual(["invalid"]);
  });
});
