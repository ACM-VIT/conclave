import { afterEach, describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAppsHandlers } from "../server/socket/handlers/appsHandlers.js";
import { createSfuState } from "../server/state.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  MAX_APP_DOC_BYTES,
  MAX_CLIENT_IDS_PER_PARTICIPANT,
  MAX_NEW_CLIENT_IDS_PER_UPDATE,
  MAX_PRESENCE_IDS_PER_PARTICIPANT,
  MAX_ROOM_APP_DOCS,
  RoomApps,
} from "../server/roomApps.js";
import type { AppsState } from "../types.js";

type Listener = (...args: unknown[]) => unknown;
type Sent = { event: string; payload: unknown };

const makeRoom = () => {
  const broadcasts: Sent[] = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
    }),
  } as unknown as SocketIOServer;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "apps-stage",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const router = { closed: false, close: () => {} } as unknown as Router;
  const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router });
  state.rooms.set(room.channelId, room);

  // How many times the stage moved to another app or document, as a client
  // following apps:state sees it.
  const stageChanges = (): number => {
    let changes = 0;
    let last = "";
    for (const sent of broadcasts) {
      if (sent.event !== "apps:state") continue;
      const state = sent.payload as AppsState;
      const key = `${state.activeAppId}:${state.docGeneration}`;
      if (key !== last) changes += 1;
      last = key;
    }
    return changes;
  };

  const join = (id: string, role: "host" | "participant", firstCopy: Y.Doc = new Y.Doc()) => {
    let doc = firstCopy;
    const listeners = new Map<string, Listener>();
    const relayed: Sent[] = [];
    const received: Sent[] = [];
    const socket = {
      id: `socket-${id}`,
      data: { user: {} },
      on: (event: string, listener: Listener) => {
        listeners.set(event, listener);
        return socket;
      },
      to: () => ({
        emit: (event: string, payload: unknown) => relayed.push({ event, payload }),
      }),
      emit: (event: string, payload: unknown) => {
        received.push({ event, payload });
        return true;
      },
    } as unknown as Socket;
    const client = role === "host" ? new Admin({ id, socket }) : new Client({ id, socket });
    room.addClient(client);
    const context = createConnectionContext(io, socket, state);
    context.currentRoom = room;
    context.currentClient = client;
    registerAppsHandlers(context);

    const ask = <T>(event: string, ...args: unknown[]): T => {
      let response: T | undefined;
      listeners.get(event)!(...args, (value: T) => {
        response = value;
      });
      return response as T;
    };
    // Like every client, sync the presented app again whenever the stage
    // moves to another app or document before writing to it.
    let syncedAt: number | null = null;
    const sync = (appId: string) => {
      const response = ask<{ syncMessage?: Uint8Array; stateVector?: Uint8Array; error?: string }>(
        "apps:yjs:sync",
        { appId, syncMessage: Y.encodeStateVector(doc) },
      );
      if (response.syncMessage) {
        Y.applyUpdate(doc, response.syncMessage);
        syncedAt = stageChanges();
      }
      return response;
    };
    const ensureSynced = (appId: string) => {
      if (syncedAt !== stageChanges()) sync(appId);
    };
    const send = (appId: string, update: Uint8Array) =>
      listeners.get("apps:yjs:update")!({ appId, update });
    return {
      relayed,
      received,
      get doc() {
        return doc;
      },
      freshCopy: () => {
        doc = new Y.Doc();
      },
      sendUpdate: (appId: string, update: Uint8Array) => {
        ensureSynced(appId);
        send(appId, update);
      },
      // Sends without syncing first: an older client drawing before its sync
      // reply arrives, or a packet still in flight from an earlier stay.
      sendAsIs: send,
      sendWithReplica: (appId: string, update: Uint8Array, replicaId: string) => {
        ensureSynced(appId);
        listeners.get("apps:yjs:update")!({ appId, update, replicaId });
      },
      present: (appId: string, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:open", { appId, expectedRevision }),
      closeLegacy: () => ask<{ success: boolean; error?: string }>("apps:close"),
      close: (expectedRevision: number) =>
        ask<{ success: boolean; error?: string }>("apps:close", { expectedRevision }),
      discard: (appId: string, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:discard", { appId, expectedRevision }),
      lock: (locked: boolean, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:lock", { locked, expectedRevision }),
      state: () => ask<AppsState>("apps:getState"),
      draw: (appId: string, key: string, value: unknown = true) => {
        ensureSynced(appId);
        const before = Y.encodeStateVector(doc);
        doc.getMap("shapes").set(key, value);
        listeners.get("apps:yjs:update")!({ appId, update: Y.encodeStateAsUpdate(doc, before) });
      },
      // Sends everything this client's copy holds, whoever wrote it.
      sendWholeCopy: (appId: string) => {
        ensureSynced(appId);
        send(appId, Y.encodeStateAsUpdate(doc));
      },
      // What a native client does when it reconnects: sync its local copy,
      // then send the server whatever that copy has and the server lacks.
      resync: (appId: string) => {
        const response = sync(appId);
        send(appId, Y.encodeStateAsUpdate(doc, response.stateVector));
      },
      sendAwareness: (appId: string, awareness: Awareness) =>
        listeners.get("apps:awareness")!({
          appId,
          awarenessUpdate: encodeAwarenessUpdate(awareness, [awareness.clientID]),
          clientId: awareness.clientID,
        }),
      sendRawAwareness: (appId: string, awarenessUpdate: Uint8Array, clientId: number) =>
        listeners.get("apps:awareness")!({ appId, awarenessUpdate, clientId }),
      sendAwarenessBatch: (appId: string, awareness: Awareness, clientIds: number[]) =>
        listeners.get("apps:awareness")!({
          appId,
          awarenessUpdate: encodeAwarenessUpdate(awareness, clientIds),
          clientId: awareness.clientID,
        }),
      syncReply: (appId: string) =>
        ask<unknown>("apps:yjs:sync", { appId, syncMessage: Y.encodeStateVector(new Y.Doc()) }),
      // Syncs this client's own copy, as a client does when the app opens.
      syncReplyInto: (appId: string) => sync(appId),
      coldUpdate: (appId: string) =>
        ask<{ syncMessage: Uint8Array }>("apps:yjs:sync", {
          appId,
          syncMessage: Y.encodeStateVector(new Y.Doc()),
        }).syncMessage,
      // What a client that joins (or returns to) the app now receives.
      coldSync: (appId: string) => {
        const response = ask<{ syncMessage?: Uint8Array; error?: string }>("apps:yjs:sync", {
          appId,
          syncMessage: Y.encodeStateVector(new Y.Doc()),
        });
        if (!response.syncMessage) return { error: response.error };
        const fresh = new Y.Doc();
        Y.applyUpdate(fresh, response.syncMessage);
        return { shapes: Array.from(fresh.getMap("shapes").keys()).sort() };
      },
    };
  };

  return { room, broadcasts, join };
};

// An update that writes under `clientID`, starting at `clock`, as a client
// claiming that id would send it.
const forgedUpdate = (clientID: number, clock: number, key: string): Uint8Array => {
  const forger = new Y.Doc();
  forger.clientID = clientID;
  for (let index = 0; index < clock; index += 1) forger.getMap("pad").set(`p${index}`, index);
  const before = Y.encodeStateVector(forger);
  forger.getMap("shapes").set(key, true);
  return Y.encodeStateAsUpdate(forger, before);
};

// A presence packet with one entry per id, in order, repeats included.
const presencePacket = (clientIds: number[], clock = 1, state = "{}"): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clientIds.length);
  for (const clientId of clientIds) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, state);
  }
  return encoding.toUint8Array(encoder);
};

const authoredBy = (clientIds: number[]): Uint8Array =>
  Y.mergeUpdates(
    clientIds.map((clientId) => {
      const author = new Y.Doc();
      author.clientID = clientId;
      author.getMap("shapes").set(`s${clientId}`, true);
      return Y.encodeStateAsUpdate(author);
    }),
  );

type RawId = { client: number; clock: number };
type RawStruct = {
  client: number;
  clock: number;
  origin?: RawId;
  right?: RawId;
  parent?: string | RawId;
  key?: string;
  value?: unknown;
  type?: "array" | "map";
};

const writeId = (encoder: encoding.Encoder, id: RawId) => {
  encoding.writeVarUint(encoder, id.client);
  encoding.writeVarUint(encoder, id.clock);
};

const rawUpdate = (structs: RawStruct[], deletes: Array<RawId & { len: number }> = []): Uint8Array => {
  const encoder = encoding.createEncoder();
  const byClient = new Map<number, RawStruct[]>();
  for (const struct of structs) byClient.set(struct.client, [...(byClient.get(struct.client) ?? []), struct]);
  encoding.writeVarUint(encoder, byClient.size);
  for (const [client, list] of byClient) {
    list.sort((a, b) => a.clock - b.clock);
    encoding.writeVarUint(encoder, list.length);
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, list[0].clock);
    for (const struct of list) {
      const anchored = struct.origin !== undefined || struct.right !== undefined;
      const keyed = !anchored && struct.key !== undefined;
      encoding.writeUint8(
        encoder,
        (struct.type ? 7 : 8) | (struct.origin ? 128 : 0) | (struct.right ? 64 : 0) | (keyed ? 32 : 0),
      );
      if (struct.origin) writeId(encoder, struct.origin);
      if (struct.right) writeId(encoder, struct.right);
      if (!anchored) {
        if (typeof struct.parent === "string") {
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarString(encoder, struct.parent);
        } else {
          encoding.writeVarUint(encoder, 0);
          writeId(encoder, struct.parent ?? { client: 0, clock: 0 });
        }
        if (keyed) encoding.writeVarString(encoder, struct.key!);
      }
      if (struct.type) {
        encoding.writeVarUint(encoder, struct.type === "map" ? 1 : 0);
      } else {
        encoding.writeVarUint(encoder, 1);
        encoding.writeAny(encoder, (struct.value ?? 1) as never);
      }
    }
  }
  const deletesByClient = new Map<number, Array<RawId & { len: number }>>();
  for (const range of deletes) {
    deletesByClient.set(range.client, [...(deletesByClient.get(range.client) ?? []), range]);
  }
  encoding.writeVarUint(encoder, deletesByClient.size);
  for (const [client, ranges] of deletesByClient) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, ranges.length);
    for (const range of ranges) {
      encoding.writeVarUint(encoder, range.clock);
      encoding.writeVarUint(encoder, range.len);
    }
  }
  return encoding.toUint8Array(encoder);
};

const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const textBy = (doc: Y.Doc, text: string): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  doc.getText("t").insert(doc.getText("t").length, text);
  return Y.encodeStateAsUpdate(doc, before);
};

const clockOf = (doc: Y.Doc): number =>
  Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;

// Writes a page of strokes the way a whiteboard does: one page map under a
// fixed key of the board, holding a stroke per key.
const writePage = (doc: Y.Doc, strokes: string[]): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  const board = doc.getMap("board");
  let page = board.get("page");
  if (!(page instanceof Y.Map)) {
    page = new Y.Map();
    board.set("page", page);
  }
  for (const stroke of strokes) (page as Y.Map<boolean>).set(stroke, true);
  return Y.encodeStateAsUpdate(doc, before);
};

const pageOf = (update: Uint8Array): string[] => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const page = doc.getMap("board").get("page");
  return page instanceof Y.Map ? Array.from(page.keys()).sort() : [];
};

const lastState = (broadcasts: Sent[]): AppsState =>
  broadcasts.filter((sent) => sent.event === "apps:state").at(-1)!.payload as AppsState;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("presenting apps keeps their documents", () => {
  it("brings the same strokes back when the host presents another app and returns", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    expect(host.present("whiteboard").success).toBe(true);
    host.draw("whiteboard", "circle");
    guest.draw("whiteboard", "arrow");

    expect(host.present("watch").success).toBe(true);
    expect(guest.coldSync("whiteboard")).toEqual({ error: "App not active" });

    expect(host.present("whiteboard").success).toBe(true);
    expect(guest.coldSync("whiteboard")).toEqual({ shapes: ["arrow", "circle"] });
  });

  it("keeps the board when the host closes it, from an older client too", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    expect(host.closeLegacy().success).toBe(true);
    expect(host.state()).toMatchObject({ activeAppId: null, savedAppIds: ["whiteboard"] });

    host.present("whiteboard");
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("drops updates and presence for an app that is not on the stage", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    host.present("watch");
    guest.draw("whiteboard", "late-stroke");
    guest.sendAwareness("whiteboard", new Awareness(new Y.Doc()));

    expect(guest.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    host.present("whiteboard");
    expect(guest.coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("removes everyone's presence from the app that leaves the stage", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");
    host.present("whiteboard");
    const cursor = new Awareness(new Y.Doc());
    cursor.setLocalState({ user: { id: "guest#1" } });
    guest.sendAwareness("whiteboard", cursor);

    host.present("watch");

    const removal = broadcasts.find((sent) => sent.event === "apps:awareness");
    expect(removal?.payload).toMatchObject({ appId: "whiteboard" });
  });
});

describe("clearing an app", () => {
  it("erases a closed board for everyone", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    host.close(host.state().revision);

    expect(host.discard("whiteboard", host.state().revision).success).toBe(true);
    expect(lastState(broadcasts).savedAppIds).toEqual([]);

    host.present("whiteboard");
    expect(host.coldSync("whiteboard")).toEqual({ shapes: [] });
  });

  it("takes the presented app off the stage when it is cleared", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");

    expect(host.discard("whiteboard").success).toBe(true);
    expect(lastState(broadcasts)).toMatchObject({ activeAppId: null, savedAppIds: [] });
  });

  it("stays cleared for every writer, however many a room clears", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    const writers = Array.from({ length: 50 }, (_, index) => {
      const writer = join(`writer#${index}`, "participant");
      const ids = Array.from({ length: 100 }, (_, offset) => 100_000 + index * 100 + offset);
      for (let start = 0; start < ids.length; start += MAX_NEW_CLIENT_IDS_PER_UPDATE) {
        writer.sendUpdate("whiteboard", authoredBy(ids.slice(start, start + MAX_NEW_CLIENT_IDS_PER_UPDATE)));
      }
      return { writer, lastCopy: authoredBy([ids.at(-1)!]) };
    });
    expect(join("before#1", "participant").coldSync("whiteboard").shapes).toHaveLength(5000);

    host.close(host.state().revision);
    host.discard("whiteboard", host.state().revision);
    host.present("whiteboard");
    for (const { writer, lastCopy } of writers) writer.sendUpdate("whiteboard", lastCopy);

    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: [] });
  }, 30_000);

  it("stays cleared when a client that missed the clear resyncs its old copy", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const away = join("native#1", "participant");
    host.present("whiteboard");
    away.draw("whiteboard", "circle");
    host.draw("whiteboard", "arrow");

    host.close(host.state().revision);
    host.discard("whiteboard", host.state().revision);
    host.present("whiteboard");
    const fresh = join("fresh#1", "participant");
    fresh.draw("whiteboard", "square");
    away.relayed.length = 0;

    away.resync("whiteboard");
    away.draw("whiteboard", "circle", "moved");
    away.draw("whiteboard", "late-stroke");

    expect(away.relayed).toEqual([]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["square"] });
  });

  it("lets the host keep editing when someone mixes cleared content into an update", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const away = join("native#1", "participant");
    host.present("whiteboard");
    away.draw("whiteboard", "circle");
    host.discard("whiteboard");
    host.present("whiteboard");
    // A client presenting the app again starts from a fresh local copy.
    const presenter = join("host#2", "host");
    presenter.draw("whiteboard", "square");

    away.resync("whiteboard");
    away.sendWholeCopy("whiteboard");
    presenter.draw("whiteboard", "triangle");

    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({
      shapes: ["square", "triangle"],
    });
  });

  it("keeps another app's copied bytes from blocking the board when that app is cleared", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const artist = join("artist#1", "participant");
    const attacker = join("attacker#1", "participant");
    host.present("whiteboard");
    artist.draw("whiteboard", "circle");
    attacker.resync("whiteboard");
    host.present("wheel");
    attacker.sendWholeCopy("wheel");
    host.present("whiteboard");
    host.discard("wheel");
    host.lock(true);

    const returning = join("host#2", "host");
    returning.resync("whiteboard");
    returning.relayed.length = 0;
    returning.draw("whiteboard", "circle", "moved");

    expect(returning.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
  });

  it("stops only the cleared app's writers, and keeps each client id to its own app", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const wheelWriter = join("writer#1", "participant");
    const boardWriter = join("writer#1", "participant");
    const reusedId = join("writer#1", "participant");
    wheelWriter.doc.clientID = 7;
    boardWriter.doc.clientID = 8;
    reusedId.doc.clientID = 7;
    host.present("wheel");
    wheelWriter.draw("wheel", "name");
    host.discard("wheel");
    host.present("whiteboard");

    boardWriter.draw("whiteboard", "circle");
    reusedId.draw("whiteboard", "square");

    expect(boardWriter.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(reusedId.relayed).toEqual([]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("starts a cleared app on a new document generation", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    const first = host.state().docGeneration;

    host.lock(true);
    host.present("watch");
    host.present("whiteboard");
    expect(host.state().docGeneration).toBe(first);

    host.discard("whiteboard");
    expect(host.state().docGeneration).toBeNull();
    host.present("whiteboard");
    expect(host.state().docGeneration).not.toBe(first);
    expect(host.state().docGeneration).toEqual(expect.any(Number));
  });

  it("is only for hosts", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");
    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    host.present("watch");

    expect(guest.discard("whiteboard")).toMatchObject({ success: false });
    expect(guest.present("whiteboard")).toMatchObject({ success: false });
    expect(guest.closeLegacy()).toMatchObject({ success: false });
    expect(host.state()).toMatchObject({ activeAppId: "watch", savedAppIds: ["whiteboard"] });
  });
});

describe("Yjs client ids", () => {
  it("refuses an update written under another participant's client id", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const editor = join("editor#1", "participant");
    const spoofer = join("spoofer#1", "participant");
    host.present("whiteboard");
    editor.draw("whiteboard", "circle");

    spoofer.sendUpdate("whiteboard", forgedUpdate(editor.doc.clientID, clockOf(editor.doc), "forged"));

    expect(spoofer.relayed).toEqual([]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("keeps an editor drawing after another app takes the id their cursor showed", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const editor = join("editor#1", "participant");
    const attacker = join("attacker#1", "participant");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    const presence = new Awareness(editor.doc);
    presence.setLocalState({ user: { id: "editor#1" } });
    editor.sendAwareness("whiteboard", presence);
    host.present("wheel");
    attacker.sendUpdate("wheel", forgedUpdate(editor.doc.clientID, 0, "claimed"));
    host.present("whiteboard");
    editor.freshCopy();

    editor.relayed.length = 0;
    editor.draw("whiteboard", "square");

    expect(editor.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle", "square"] });
    presence.destroy();
  });

  it("lets a host draw after locking, whatever another participant wrote under their old id", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const artist = join("artist#1", "participant");
    const attacker = join("attacker#1", "participant");
    host.present("whiteboard");
    artist.draw("whiteboard", "circle");
    const presence = new Awareness(host.doc);
    presence.setLocalState({ user: { id: "host#1" } });
    host.sendAwareness("whiteboard", presence);
    host.present("wheel");
    attacker.sendUpdate("wheel", forgedUpdate(host.doc.clientID, 0, "claimed"));
    host.present("whiteboard");
    host.lock(true);
    host.freshCopy();

    host.relayed.length = 0;
    host.draw("whiteboard", "square");

    expect(host.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    presence.destroy();
  });

  it("binds a client id shown in presence before its owner draws", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const editor = join("editor#1", "participant");
    const squatter = join("squatter#1", "participant");
    host.present("whiteboard");
    const presence = new Awareness(editor.doc);
    presence.setLocalState({ user: { id: "editor#1" } });
    editor.sendAwareness("whiteboard", presence);

    squatter.sendUpdate("whiteboard", forgedUpdate(editor.doc.clientID, 0, "squatted"));
    editor.draw("whiteboard", "circle");

    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
    presence.destroy();
  });

  it("reads every entry of a presence batch, whatever the length of each state", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    const spoofer = join("spoofer#1", "participant");
    host.present("whiteboard");
    const first = new Awareness(new Y.Doc());
    first.setLocalState({ user: { id: "viewer#1" } });
    const second = new Awareness(new Y.Doc());
    second.setLocalState({ user: { id: "viewer#1", name: "v".repeat(200) } });
    applyAwarenessUpdate(first, encodeAwarenessUpdate(second, [second.clientID]), "tab");

    viewer.sendAwarenessBatch("whiteboard", first, [first.clientID, second.clientID]);
    spoofer.sendUpdate("whiteboard", forgedUpdate(second.clientID, 0, "squatted"));

    expect(viewer.relayed.map((sent) => sent.event)).toEqual(["apps:awareness"]);
    expect(spoofer.relayed).toEqual([]);
    first.destroy();
    second.destroy();
  });

  it("forwards a sender's own cursor from a batch that also removes someone else's", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    const peer = join("peer#1", "participant");
    host.present("whiteboard");
    const peerPresence = new Awareness(new Y.Doc());
    peerPresence.setLocalState({ user: { id: "peer#1" } });
    peer.sendAwareness("whiteboard", peerPresence);
    const viewerPresence = new Awareness(new Y.Doc());
    applyAwarenessUpdate(
      viewerPresence,
      encodeAwarenessUpdate(peerPresence, [peerPresence.clientID]),
      "remote",
    );
    removeAwarenessStates(viewerPresence, [peerPresence.clientID], "timeout");
    viewerPresence.setLocalState({ user: { id: "viewer#1" }, cursor: { x: 1, y: 2 } });

    viewer.sendAwarenessBatch("whiteboard", viewerPresence, [
      viewerPresence.clientID,
      peerPresence.clientID,
    ]);

    const relayed = viewer.relayed.find((sent) => sent.event === "apps:awareness");
    expect(relayed).toBeDefined();
    const forwarded = new Awareness(new Y.Doc());
    applyAwarenessUpdate(
      forwarded,
      (relayed!.payload as { awarenessUpdate: Uint8Array }).awarenessUpdate,
      "remote",
    );
    expect(Array.from(forwarded.meta.keys()).filter((id) => id !== forwarded.clientID)).toEqual([
      viewerPresence.clientID,
    ]);
    for (const presence of [peerPresence, viewerPresence, forwarded]) presence.destroy();
  });

  it("drops a presence update that ends partway through an entry", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    const presence = new Awareness(new Y.Doc());
    presence.setLocalState({ user: { id: "viewer#1" } });
    const whole = encodeAwarenessUpdate(presence, [presence.clientID]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    viewer.sendAwarenessBatch("whiteboard", presence, []);
    const truncated = whole.slice(0, whole.length - 3);
    expect(() =>
      viewer.sendRawAwareness("whiteboard", truncated, presence.clientID),
    ).not.toThrow();

    expect(viewer.relayed).toEqual([]);
    presence.destroy();
  });

  it("refuses a presence batch that carries someone else's state", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    const peer = join("peer#1", "participant");
    host.present("whiteboard");
    const peerPresence = new Awareness(new Y.Doc());
    peerPresence.setLocalState({ user: { id: "peer#1" } });
    peer.sendAwareness("whiteboard", peerPresence);
    const viewerPresence = new Awareness(new Y.Doc());
    applyAwarenessUpdate(
      viewerPresence,
      encodeAwarenessUpdate(peerPresence, [peerPresence.clientID]),
      "remote",
    );

    viewer.sendAwarenessBatch("whiteboard", viewerPresence, [
      viewerPresence.clientID,
      peerPresence.clientID,
    ]);

    expect(viewer.relayed).toEqual([]);
    peerPresence.destroy();
    viewerPresence.destroy();
  });

  it("removes only a leaving participant's own cursors, whatever id they name", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    const peer = join("peer#1", "participant");
    host.present("whiteboard");
    const peerPresence = new Awareness(new Y.Doc());
    peerPresence.setLocalState({ user: { id: "peer#1" } });
    peer.sendAwareness("whiteboard", peerPresence);
    const viewerPresence = new Awareness(new Y.Doc());
    viewerPresence.setLocalState({ user: { id: "viewer#1" } });

    viewer.sendRawAwareness(
      "whiteboard",
      encodeAwarenessUpdate(viewerPresence, [viewerPresence.clientID]),
      peerPresence.clientID,
    );
    room.apps.clearUserAwareness("viewer#1");

    const left = new Awareness(new Y.Doc());
    applyAwarenessUpdate(left, room.apps.encodeAwarenessSnapshot("whiteboard")!, "remote");
    expect(left.getStates().has(peerPresence.clientID)).toBe(true);
    expect(left.getStates().has(viewerPresence.clientID)).toBe(false);
    for (const presence of [peerPresence, viewerPresence, left]) presence.destroy();
  });

  it("counts a client id once against a participant's limit, however often a packet names it", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    const held = Array.from({ length: MAX_PRESENCE_IDS_PER_PARTICIPANT - 1 }, (_, index) => 1000 + index);

    viewer.sendRawAwareness("whiteboard", presencePacket(held), held[0]);
    viewer.sendRawAwareness("whiteboard", presencePacket([5, 5]), 5);

    expect(viewer.relayed.filter((sent) => sent.event === "apps:awareness")).toHaveLength(2);
  });

  it("removes no one's cursor when a participant who showed none leaves", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    const peer = join("peer#1", "participant");
    join("viewer#1", "participant");
    host.present("whiteboard");
    const peerPresence = new Awareness(new Y.Doc());
    peerPresence.setLocalState({ user: { id: "viewer#1" } });
    peer.sendAwareness("whiteboard", peerPresence);

    expect(room.apps.clearUserAwareness("viewer#1")).toEqual([]);

    const left = new Awareness(new Y.Doc());
    applyAwarenessUpdate(left, room.apps.encodeAwarenessSnapshot("whiteboard")!, "remote");
    expect(left.getStates().has(peerPresence.clientID)).toBe(true);
    peerPresence.destroy();
    left.destroy();
  });

  it("keeps a participant's own client id when they rejoin", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const native = join("native#1", "participant");
    host.present("whiteboard");
    native.draw("whiteboard", "circle");

    const rejoined = join("native#1", "participant", native.doc);
    rejoined.resync("whiteboard");
    rejoined.relayed.length = 0;
    rejoined.draw("whiteboard", "square");

    expect(rejoined.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({
      shapes: ["circle", "square"],
    });
  });
});

describe("client id reservations", () => {
  it("keeps a fresh writer usable after sixteen identities flood presence with client ids", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    for (let index = 0; index < 16; index += 1) {
      const ids = Array.from({ length: 1024 }, (_, offset) => 10_000_000 + index * 1024 + offset);
      join(`flood#${index}`, "participant").sendRawAwareness("whiteboard", presencePacket(ids), ids[0]);
    }
    const writer = join("writer#1", "participant");

    writer.draw("whiteboard", "circle");

    expect(writer.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("refuses a presence packet that names more new ids than a participant may show", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    const ids = Array.from({ length: MAX_PRESENCE_IDS_PER_PARTICIPANT + 1 }, (_, index) => 500 + index);

    viewer.sendRawAwareness("whiteboard", presencePacket(ids), ids[0]);

    expect(viewer.relayed).toEqual([]);
  });

  it("frees a participant's presence ids when their cursors go, so they can keep showing new ones", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    join("viewer#1", "participant");
    host.present("whiteboard");

    const shown = Array.from({ length: 1100 }, (_, index) => {
      const id = 20_000 + index;
      const forwarded = room.apps.applyAwarenessUpdate("whiteboard", presencePacket([id]), "viewer#1");
      room.apps.applyAwarenessUpdate("whiteboard", presencePacket([id], 2, "null"), "viewer#1");
      return forwarded !== null;
    });

    expect(shown.every(Boolean)).toBe(true);
  });

  it("frees a leaving participant's presence ids for others", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    join("viewer#1", "participant");
    join("next#1", "participant");
    host.present("whiteboard");
    room.apps.applyAwarenessUpdate("whiteboard", presencePacket([900]), "viewer#1");

    room.apps.clearUserAwareness("viewer#1");

    expect(room.apps.applyAwarenessUpdate("whiteboard", presencePacket([900]), "next#1")).not.toBeNull();
  });

  it("refuses an update that claims more new client ids than one update may", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const writer = join("writer#1", "participant");
    host.present("whiteboard");
    const allowed = Array.from({ length: MAX_NEW_CLIENT_IDS_PER_UPDATE }, (_, index) => 30_000 + index);
    const tooMany = Array.from({ length: MAX_NEW_CLIENT_IDS_PER_UPDATE + 1 }, (_, index) => 31_000 + index);

    writer.sendUpdate("whiteboard", authoredBy(tooMany));
    writer.sendUpdate("whiteboard", authoredBy(allowed));

    expect(writer.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(join("late#1", "participant").coldSync("whiteboard").shapes).toHaveLength(allowed.length);
  });

  it("takes an empty update as nothing, even on a locked board, so no copy is started over", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    host.lock(true, host.state().revision);

    viewer.sendWithReplica("whiteboard", Y.encodeStateAsUpdate(new Y.Doc()), "copy-1");

    expect(viewer.received.filter((sent) => sent.event === "apps:yjs:refused")).toEqual([]);
    expect(viewer.relayed).toEqual([]);
  });

  it("takes a resent deletion the room already has as nothing on a locked board", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    const before = Y.encodeStateVector(host.doc);
    host.doc.getMap("shapes").delete("circle");
    host.sendUpdate("whiteboard", Y.encodeStateAsUpdate(host.doc, before));
    host.lock(true, host.state().revision);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, viewer.coldUpdate("whiteboard"));

    viewer.sendWithReplica("whiteboard", Y.encodeStateAsUpdate(copy, Y.encodeStateVector(copy)), "copy-1");

    expect(viewer.received.filter((sent) => sent.event === "apps:yjs:refused")).toEqual([]);
  });

  it("tells the writer, once per copy, that the room refused its change", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const writer = join("writer#1", "participant");
    host.present("whiteboard");
    const tooMany = Array.from({ length: MAX_NEW_CLIENT_IDS_PER_UPDATE + 1 }, (_, index) => 40_000 + index);

    writer.sendWithReplica("whiteboard", authoredBy(tooMany), "copy-1");
    writer.sendWithReplica("whiteboard", authoredBy(tooMany.map((id) => id + 100)), "copy-1");

    const refusals = writer.received.filter((sent) => sent.event === "apps:yjs:refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].payload).toMatchObject({ appId: "whiteboard", replicaId: "copy-1" });
  });
});

describe("the room applies an update whole or not at all", () => {
  const presentedBoard = () => {
    const apps = new RoomApps();
    apps.present("board");
    const seed = new Y.Doc();
    seed.clientID = 1;
    seed.getMap("m").set("kept", 1);
    seed.getMap("m").set("nested", new Y.Map());
    seed.getArray("a").insert(0, [1, 2, 3]);
    expect(apps.write("board", "host", Y.encodeStateAsUpdate(seed), apps.syncMark("board"))).toBeNull();
    const live = () => apps.liveDoc("board")!;
    const snapshot = () => Buffer.from(Y.encodeStateAsUpdate(live())).toString("base64");
    return { apps, live, snapshot };
  };

  it("reads the hand-encoded updates these tests send as Yjs does", () => {
    const update = rawUpdate([
      { client: 70, clock: 0, parent: "m", key: "fresh", value: 5 },
      { client: 70, clock: 1, parent: "m", key: "inner", type: "map" },
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    expect(doc.getMap("m").get("fresh")).toBe(5);
    expect(doc.getMap("m").get("inner")).toBeInstanceOf(Y.Map);
  });

  it("keeps a participant within their id limit when an update refers to its own item as parent", () => {
    const { apps, live, snapshot } = presentedBoard();
    const before = snapshot();
    const mark = apps.syncMark("board");

    for (let index = 0; index < MAX_CLIENT_IDS_PER_PARTICIPANT + 10; index += 1) {
      const client = 80_000 + index;
      apps.write(
        "board",
        "guest",
        rawUpdate([
          { client, clock: 0, parent: "m", key: `s${client}`, value: 1 },
          { client, clock: 1, parent: { client, clock: 1 }, key: "self", value: 2 },
        ]),
        mark,
      );
    }

    expect(snapshot()).toBe(before);
    expect(apps.boundClientIdCount).toBe(1);
    expect(live().store.pendingStructs).toBeNull();
  });

  it("refuses an update whose item refers to a later item of its own as parent", () => {
    const { apps, live, snapshot } = presentedBoard();
    const before = snapshot();
    const client = 90_000;

    const refusal = apps.write(
      "board",
      "guest",
      rawUpdate([
        { client, clock: 0, parent: "m", key: "first", value: 1 },
        { client, clock: 1, parent: { client, clock: 2 }, key: "early", value: 2 },
        { client, clock: 2, parent: "m", key: "later", type: "map" },
      ]),
      apps.syncMark("board"),
    );

    expect(refusal).toBe("unresolved");
    expect(snapshot()).toBe(before);
    expect(live().store.pendingStructs).toBeNull();
  });

  it("changes the document only by updates Yjs takes whole, across random malformed updates", () => {
    const { apps, live, snapshot } = presentedBoard();
    const random = seededRandom(270);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const mark = apps.syncMark("board");
    let accepted = 0;
    let refused = 0;

    for (let round = 0; round < 600; round += 1) {
      const client = 100_000 + round;
      const start = random() < 0.1 ? 1 : 0;
      const count = 1 + Math.floor(random() * 4);
      const liveIds = Array.from(Y.decodeStateVector(Y.encodeStateVector(live()))).flatMap(([owner, clock]) =>
        clock > 0 ? [{ client: owner, clock: Math.floor(random() * clock) }] : [],
      );
      const ref = (clock: number): RawId =>
        pick([
          ...liveIds,
          { client, clock: Math.max(0, clock - 1) },
          { client, clock },
          { client, clock: clock + 1 },
          { client: client + 1, clock: 0 },
          { client: 1, clock: 999 },
        ]);
      const structs: RawStruct[] = Array.from({ length: count }, (_, index) => {
        const clock = start + index;
        const shape = random();
        const content = random() < 0.3 ? { type: pick(["map", "array"] as const) } : { value: round };
        if (shape < 0.35) return { client, clock, parent: pick(["m", "a"]), key: pick(["kept", `k${round}`]), ...content };
        if (shape < 0.6) return { client, clock, parent: ref(clock), key: `n${index}`, ...content };
        if (shape < 0.8) return { client, clock, origin: ref(clock), ...content };
        return { client, clock, origin: ref(clock), right: ref(clock), ...content };
      });
      const deletes = random() < 0.2 ? [{ ...ref(start + count), len: 1 + Math.floor(random() * 3) }] : [];
      const update = rawUpdate(structs, deletes);

      const before = snapshot();
      const held = apps.boundClientIdCount;
      const trial = new Y.Doc();
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(live()));
      let trialClean = true;
      try {
        Y.applyUpdate(trial, update);
      } catch {
        trialClean = false;
      }
      trialClean &&= trial.store.pendingStructs === null && trial.store.pendingDs === null;

      const refusal = apps.write("board", "fuzzer", update, mark);

      expect(live().store.pendingStructs).toBeNull();
      expect(live().store.pendingDs).toBeNull();
      if (refusal) {
        refused += 1;
        expect(snapshot()).toBe(before);
        expect(apps.boundClientIdCount).toBe(held);
      } else {
        accepted += 1;
        expect(trialClean).toBe(true);
      }
    }

    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  }, 60_000);
});

describe("client ids are claimed only by a write the room takes", () => {
  const nearlyFullBoard = () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    for (let chunk = 0; chunk < 5; chunk += 1) {
      host.sendUpdate("whiteboard", textBy(host.doc, "x".repeat(200 * 1024)));
    }
    const size = Y.encodeStateAsUpdate(room.apps.liveDoc("whiteboard")!).length;
    host.sendUpdate("whiteboard", textBy(host.doc, "x".repeat(MAX_APP_DOC_BYTES - size - 400)));
    return { room, join, host };
  };

  it("keeps no claim from writes refused at the size cap, however many guests try", () => {
    const { room, join, host } = nearlyFullBoard();
    const held = room.apps.boundClientIdCount;

    for (let session = 0; session < 50; session += 1) {
      const guest = join(`guest#${session}`, "participant");
      for (let attempt = 0; attempt < MAX_NEW_CLIENT_IDS_PER_UPDATE; attempt += 1) {
        const author = new Y.Doc();
        author.clientID = 50_000 + session * 100 + attempt;
        guest.sendUpdate("whiteboard", textBy(author, "y".repeat(2048)));
      }
      expect(guest.relayed).toEqual([]);
    }

    expect(room.apps.boundClientIdCount).toBe(held);
    host.close(host.state().revision);
    host.discard("whiteboard", host.state().revision);
    host.present("whiteboard");
    const writer = join("writer#1", "participant");
    writer.draw("whiteboard", "circle");
    expect(writer.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
  });

  const refusals: Array<[string, () => { send: () => void; held: () => number; reason: () => unknown }]> = [
    ["too-large", () => {
      const { room, join } = nearlyFullBoard();
      const writer = join("writer#1", "participant");
      const author = new Y.Doc();
      author.clientID = 60_001;
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", textBy(author, "y".repeat(2048)), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["locked", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      host.lock(true, host.state().revision);
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", authoredBy([60_002]), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["not-synced", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendAsIs("whiteboard", authoredBy([60_003])),
        reason: () => (writer.relayed.length === 0 ? { reason: "not-synced" } : undefined),
      };
    }],
    ["unresolved", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", forgedUpdate(60_004, 3, "gap"), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["unseen-value", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      host.sendUpdate("whiteboard", writePage(host.doc, ["kept"]));
      const fresh = new Y.Doc();
      fresh.clientID = 60_005;
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", writePage(fresh, ["early"]), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["foreign-id", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const owner = join("owner#1", "participant");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      owner.sendUpdate("whiteboard", authoredBy([60_006]));
      return {
        held: () => room.apps.boundClientIdCount,
        send: () =>
          writer.sendWithReplica(
            "whiteboard",
            Y.mergeUpdates([authoredBy([60_007]), forgedUpdate(60_006, 1, "taken")]),
            "copy",
          ),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["id-limit", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      const ids = Array.from({ length: MAX_NEW_CLIENT_IDS_PER_UPDATE + 1 }, (_, index) => 61_000 + index);
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", authoredBy(ids), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
    ["malformed", () => {
      const { room, join } = makeRoom();
      const host = join("host#1", "host");
      const writer = join("writer#1", "participant");
      host.present("whiteboard");
      return {
        held: () => room.apps.boundClientIdCount,
        send: () => writer.sendWithReplica("whiteboard", Uint8Array.from([1, 1, 200, 200, 200]), "copy"),
        reason: () => writer.received.find((sent) => sent.event === "apps:yjs:refused")?.payload,
      };
    }],
  ];

  it.each(refusals)("keeps no claim from a write refused as %s", (reason, setup) => {
    const scenario = setup();
    const held = scenario.held();

    scenario.send();

    expect(scenario.reason()).toMatchObject({ reason });
    expect(scenario.held()).toBe(held);
  });
});

describe("updates in flight across a stage change", () => {
  const savedBoard = () => {
    const { join } = makeRoom();
    const hostDoc = new Y.Doc();
    hostDoc.clientID = 1;
    const host = join("host#1", "host", hostDoc);
    host.present("whiteboard");
    host.sendUpdate("whiteboard", writePage(hostDoc, ["saved"]));
    const reopen = () => {
      host.close(host.state().revision);
      host.present("whiteboard");
    };
    const cold = () => pageOf(join(`cold#${Math.random()}`, "participant").coldUpdate("whiteboard"));
    return { join, reopen, cold };
  };

  it("keeps a synced viewer's stroke that arrives after the board is closed and presented again", () => {
    const { join, reopen, cold } = savedBoard();
    const viewerDoc = new Y.Doc();
    const viewer = join("viewer#1", "participant", viewerDoc);
    viewer.syncReplyInto("whiteboard");
    const late = writePage(viewerDoc, ["late"]);

    reopen();
    viewer.sendAsIs("whiteboard", late);

    expect(viewer.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(cold()).toEqual(["late", "saved"]);
  });

  it("keeps a build 63 client's stroke sent before Close, and takes its next session's strokes", () => {
    const { join, reopen, cold } = savedBoard();
    const firstSession = new Y.Doc();
    const native = join("native#1", "participant", firstSession);
    native.syncReplyInto("whiteboard");
    const sentBeforeClose = writePage(firstSession, ["before-close"]);

    reopen();
    native.sendAsIs("whiteboard", sentBeforeClose);
    const nextSession = new Y.Doc();
    Y.applyUpdate(nextSession, native.coldUpdate("whiteboard"));
    native.sendAsIs("whiteboard", writePage(nextSession, ["next-session"]));

    expect(native.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update", "apps:yjs:update"]);
    expect(cold()).toEqual(["before-close", "next-session", "saved"]);
  });

  it("refuses a fresh copy's page from a tab that synced before the saved page existed", () => {
    const { join } = makeRoom();
    const hostDoc = new Y.Doc();
    hostDoc.clientID = 1;
    const host = join("host#1", "host", hostDoc);
    host.present("whiteboard");
    const tab = join("tab#1", "participant");
    tab.syncReplyInto("whiteboard");
    host.sendUpdate("whiteboard", writePage(hostDoc, ["kept"]));
    host.close(host.state().revision);
    host.present("whiteboard");
    const freshCopy = new Y.Doc();
    freshCopy.clientID = 2 ** 31;

    tab.sendAsIs("whiteboard", writePage(freshCopy, ["early"]));

    expect(tab.relayed).toEqual([]);
    expect(pageOf(join("cold#1", "participant").coldUpdate("whiteboard"))).toEqual(["kept"]);
  });
});

describe("writes made before a client's first sync", () => {
  // A host saves a page, closes the board and presents it again; an older
  // client then opens it on a fresh copy and draws before the room's copy
  // reaches it. Its page would replace the saved one for everyone.
  const savedBoardWithEarlyDrawer = () => {
    const { room, join } = makeRoom();
    const hostDoc = new Y.Doc();
    hostDoc.clientID = 1;
    const host = join("host#1", "host", hostDoc);
    host.present("whiteboard");
    host.sendUpdate("whiteboard", writePage(hostDoc, ["kept-1", "kept-2"]));
    host.close(host.state().revision);
    host.present("whiteboard");
    const earlyDoc = new Y.Doc();
    earlyDoc.clientID = 2 ** 31;
    const early = join("early#1", "participant", earlyDoc);
    const cold = () => pageOf(join(`cold#${Math.random()}`, "participant").coldUpdate("whiteboard"));
    return { room, host, early, earlyDoc, cold };
  };

  it("keeps the saved board when an older client draws before its first sync", () => {
    const { early, earlyDoc, cold } = savedBoardWithEarlyDrawer();

    early.sendAsIs("whiteboard", writePage(earlyDoc, ["early"]));
    const pushed = early.received.find((sent) => sent.event === "apps:yjs:update");
    expect(pushed).toBeDefined();
    const roomCopy = (pushed!.payload as { update: Uint8Array }).update;
    Y.applyUpdate(earlyDoc, roomCopy);
    early.sendAsIs(
      "whiteboard",
      Y.encodeStateAsUpdate(earlyDoc, Y.encodeStateVectorFromUpdate(roomCopy)),
    );
    early.sendAsIs("whiteboard", writePage(earlyDoc, ["later"]));

    expect(early.relayed).toEqual([]);
    expect(cold()).toEqual(["kept-1", "kept-2"]);
  });

  it("takes an early write that replaces nothing once the client has the room's copy", () => {
    const { early, earlyDoc, cold } = savedBoardWithEarlyDrawer();
    const before = Y.encodeStateVector(earlyDoc);
    earlyDoc.getMap("notes").set("early", true);

    early.sendAsIs("whiteboard", Y.encodeStateAsUpdate(earlyDoc, before));
    expect(early.relayed).toEqual([]);
    early.resync("whiteboard");

    expect(early.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    expect(cold()).toEqual(["kept-1", "kept-2"]);
  });

  it("sends a client that writes before syncing the room's copy once per stay", () => {
    const { early, earlyDoc } = savedBoardWithEarlyDrawer();

    early.sendAsIs("whiteboard", writePage(earlyDoc, ["early-1"]));
    early.sendAsIs("whiteboard", writePage(earlyDoc, ["early-2"]));

    const pushes = early.received.filter((sent) => sent.event === "apps:yjs:update");
    expect(pushes).toHaveLength(1);
    expect(pageOf((pushes[0].payload as { update: Uint8Array }).update)).toEqual([
      "kept-1",
      "kept-2",
    ]);
  });

  it("lets a synced client replace a value it has seen", () => {
    const { host, cold } = savedBoardWithEarlyDrawer();
    const hostDoc = host.doc;
    const before = Y.encodeStateVector(hostDoc);
    const fresh = new Y.Map<boolean>();
    hostDoc.getMap("board").set("page", fresh);
    fresh.set("redrawn", true);

    host.sendUpdate("whiteboard", Y.encodeStateAsUpdate(hostDoc, before));

    expect(cold()).toEqual(["redrawn"]);
  });
});

describe("stage revision", () => {
  it("rejects a stage command made against an older stage", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    const seen = first.state().revision;

    expect(second.present("watch", seen).success).toBe(true);
    expect(first.present("whiteboard", seen)).toEqual({
      success: false,
      error: "The stage changed. Try again.",
      code: "stale_revision",
    });
    expect(first.discard("watch", seen)).toMatchObject({ success: false });
    expect(first.state().activeAppId).toBe("watch");
  });

  it("accepts a repeated command for the state the room is already in", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    const seen = first.state().revision;

    second.present("whiteboard", seen);
    expect(first.present("whiteboard", seen).success).toBe(true);
    second.close(first.state().revision);
    expect(first.close(seen).success).toBe(true);
  });

  it("moves forward with every change older clients can make", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const revisions = [host.state().revision];
    host.present("whiteboard");
    revisions.push(host.state().revision);
    host.lock(true);
    revisions.push(host.state().revision);
    host.closeLegacy();
    revisions.push(host.state().revision);

    expect(new Set(revisions).size).toBe(revisions.length);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });

  it("rejects a lock made against an older stage", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    first.present("whiteboard");
    const seen = first.state().revision;

    second.present("watch", seen);

    expect(first.lock(true, seen)).toMatchObject({ success: false });
    expect(first.state()).toMatchObject({ activeAppId: "watch", locked: false });
  });

  it("limits how fast one host can change the stage", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    const outcomes = Array.from({ length: 12 }, (_, index) => host.lock(index % 2 === 0).success);

    expect(outcomes.slice(0, 9).every(Boolean)).toBe(true);
    expect(outcomes.at(-1)).toBe(false);
    expect(host.present("watch")).toEqual({ success: false, error: "Too many app changes" });
  });

  it("answers a viewer's sync for every new stage however fast hosts switch", () => {
    const { join } = makeRoom();
    const hosts = [join("host#1", "host"), join("host#2", "host")];
    const viewer = join("viewer#1", "participant");
    const answers: Array<{ shapes?: string[]; error?: string }> = [];
    for (let index = 0; index < 12; index += 1) {
      const appId = index % 2 === 0 ? "whiteboard" : "wheel";
      hosts[Math.floor(index / 6)].present(appId);
      answers.push(viewer.coldSync(appId));
    }

    expect(answers.filter((answer) => answer.error)).toEqual([]);
  });

  it("still limits repeated syncs of one stage, and says when to try again", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const viewer = join("viewer#1", "participant");
    host.present("whiteboard");
    const answers = Array.from({ length: 14 }, () => viewer.syncReply("whiteboard"));

    expect(answers.at(-1)).toEqual({
      error: "Too many app sync requests",
      retryable: true,
      retryAfterMs: 500,
    });
  });

  it("starts a newly presented app unlocked", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.lock(true);
    host.present("watch");
    expect(host.state().locked).toBe(false);
  });
});

describe("room document budget", () => {
  it("tells the host the room is full so they can clear an app", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    for (let index = 0; index < MAX_ROOM_APP_DOCS; index += 1) {
      host.present(`app-${index}`);
      // Every app gets its own local document, as on a real client.
      join(`writer#${index}`, "participant").draw(`app-${index}`, "mark");
    }

    expect(host.present("one-more")).toEqual({
      success: false,
      error: "Clear an app to present another.",
      code: "room_full",
    });
  });

  const fill = (apps: RoomApps, appId: string, bytes: number) => {
    const source = new Y.Doc();
    const update = (() => {
      source.getText("t").insert(0, "x".repeat(bytes));
      return Y.encodeStateAsUpdate(source);
    })();
    expect(apps.reserveUpdate(appId, update)).toBe(true);
    Y.applyUpdate(apps.liveDoc(appId)!, update);
  };

  it("does not keep apps nobody wrote to", () => {
    const apps = new RoomApps();
    for (let index = 0; index < MAX_ROOM_APP_DOCS * 3; index += 1) {
      expect(apps.present(`app-${index}`).ok).toBe(true);
    }
    expect(apps.snapshot().savedAppIds).toEqual([]);
  });

  it("refuses another document once the room keeps its limit of apps", () => {
    const apps = new RoomApps();
    for (let index = 0; index < MAX_ROOM_APP_DOCS; index += 1) {
      apps.present(`app-${index}`);
      fill(apps, `app-${index}`, 10);
    }
    expect(apps.present("one-more")).toEqual({ ok: false, reason: "full" });
    expect(apps.present("app-0").ok).toBe(true);

    apps.discard("app-1");
    expect(apps.present("one-more").ok).toBe(true);
  });

  it("refuses another document when the room has no space for it to grow", () => {
    const apps = new RoomApps();
    for (let index = 0; index < 4; index += 1) {
      expect(apps.present(`board-${index}`).ok).toBe(true);
      fill(apps, `board-${index}`, MAX_APP_DOC_BYTES - 1024);
    }
    expect(apps.present("board-4")).toEqual({ ok: false, reason: "full" });
  });

  it("stops the presented document at the room's remaining space", () => {
    const apps = new RoomApps();
    for (let index = 0; index < 4; index += 1) {
      apps.present(`board-${index}`);
      fill(apps, `board-${index}`, (MAX_APP_DOC_BYTES * 3) / 4 - 1024);
    }
    expect(apps.present("board-4").ok).toBe(true);
    fill(apps, "board-4", MAX_APP_DOC_BYTES - 1024);
    apps.present("board-0");

    const source = new Y.Doc();
    source.getText("u").insert(0, "y".repeat(200 * 1024));
    const update = Y.encodeStateAsUpdate(source);
    expect(apps.reserveUpdate("board-0", update)).toBe(false);

    apps.discard("board-4");
    expect(apps.reserveUpdate("board-0", update)).toBe(true);
  });

  it("destroys every document when the room is torn down", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    host.present("watch");

    room.close();

    expect(host.state()).toMatchObject({ activeAppId: null, savedAppIds: [] });
    host.present("whiteboard");
    expect(host.coldSync("whiteboard")).toEqual({ shapes: [] });
  });
});
