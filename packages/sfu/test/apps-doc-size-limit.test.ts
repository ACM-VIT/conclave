import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Room } from "../config/classes/Room.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAppsHandlers } from "../server/socket/handlers/appsHandlers.js";
import { createSfuState } from "../server/state.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";

type Listener = (...args: unknown[]) => unknown;

const MAX_DOC_BYTES = 1024 * 1024;

const joinApp = (id: string, appId = "board") => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const listeners = new Map<string, Listener>();
  const emit = vi.fn();
  const socket = {
    id: `s-${id}`,
    data: { user: {} },
    on: (event: string, listener: Listener) => { listeners.set(event, listener); return socket; },
    to: () => ({ emit: vi.fn() }),
    emit,
  } as unknown as Socket;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: id, instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  const room = new Room({ id, clientId: "conclave", workerPid: null, router: {} as Router });
  state.rooms.set(room.channelId, room);
  const admin = new Admin({ id: `a#${id}`, socket });
  room.addClient(admin);
  room.appsState.activeAppId = appId;
  const context = createConnectionContext({ to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer, socket, state);
  context.currentRoom = room;
  context.currentClient = admin;
  registerAppsHandlers(context);
  return {
    send: (update: Uint8Array) => listeners.get("apps:yjs:update")!({ appId, update }),
    serverDoc: () => room.getOrCreateAppDoc(appId),
    emit,
  };
};

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
  it("stops growing a document at the size a sync can still deliver", () => {
    const { send, serverDoc } = joinApp("inserts");

    const attacker = new Y.Doc();
    const text = attacker.getText("t");
    const chunk = "x".repeat(200 * 1024);
    for (let index = 0; index < 20; index += 1) {
      const before = Y.encodeStateVector(attacker);
      text.insert(text.length, chunk);
      send(Y.encodeStateAsUpdate(attacker, before));
    }

    expect(Y.encodeStateAsUpdate(serverDoc()).length).toBeLessThanOrEqual(MAX_DOC_BYTES);
    expect(serverDoc().getText("t").length).toBeGreaterThan(0);
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

  it("refuses deletions whose item splits would push the document past the limit", () => {
    const { send, serverDoc } = joinApp("deletions");
    const serverText = () => serverDoc().getText("t").length;
    const attacker = new Y.Doc();
    attacker.clientID = 0xffffffff;
    const deletionsUpTo = (end: number) => singleCharacterDeletions(attacker.clientID, everyOtherClock(0, end));

    attacker.getText("t").insert(0, "x".repeat(120_001));
    send(Y.encodeStateAsUpdate(attacker));
    expect(serverText()).toBe(120_001);

    send(deletionsUpTo(40_000));
    expect(serverText()).toBe(100_001);
    send(deletionsUpTo(82_898));
    expect(serverText()).toBe(78_552);
    expect(Y.encodeStateAsUpdate(serverDoc()).length).toBe(MAX_DOC_BYTES);

    const oneMoreDeletion = deletionsUpTo(82_900);
    const trial = new Y.Doc();
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(serverDoc()));
    Y.applyUpdate(trial, oneMoreDeletion);
    expect(Y.encodeStateAsUpdate(trial).length).toBeGreaterThan(MAX_DOC_BYTES);

    send(oneMoreDeletion);
    expect(serverText()).toBe(78_552);
    expect(Y.encodeStateAsUpdate(serverDoc()).length).toBe(MAX_DOC_BYTES);
  }, 30_000);
});

it.each(["wheel", "board"])("echoes accepted updates to the writer only for %s when it needs publication proof", (appId) => {
  const { send, serverDoc, emit } = joinApp(`receipt-${appId}`, appId);
  const writer = new Y.Doc();
  writer.getArray("wheel.entries").push([{ id: "ada", label: "Ada" }]);
  const update = Y.encodeStateAsUpdate(writer);
  emit.mockImplementation(() => {
    expect(serverDoc().getArray("wheel.entries").toArray()).toEqual([{ id: "ada", label: "Ada" }]);
  });
  send(update);
  if (appId === "wheel") expect(emit).toHaveBeenCalledExactlyOnceWith("apps:yjs:update", { appId, update });
  else expect(emit).not.toHaveBeenCalled();

  send(Uint8Array.of(255));
  send(new Uint8Array(MAX_DOC_BYTES));
  expect(emit).toHaveBeenCalledTimes(appId === "wheel" ? 1 : 0);
});
