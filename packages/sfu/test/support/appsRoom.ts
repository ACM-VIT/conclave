import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { type Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import { createConnectionContext } from "../../server/socket/context.js";
import { registerAppsHandlers } from "../../server/socket/handlers/appsHandlers.js";
import { createSfuState } from "../../server/state.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import type { AppsState } from "../../types.js";

export type Listener = (...args: unknown[]) => unknown;
export type Sent = { event: string; payload: unknown };

export const makeRoom = () => {
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
      connected: true,
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
      sendWholeCopy: (appId: string) => {
        ensureSynced(appId);
        send(appId, Y.encodeStateAsUpdate(doc));
      },
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
      request: <T>(event: string, ...args: unknown[]) => {
        const reply: { value?: T } = {};
        listeners.get(event)!(...args, (value: T) => {
          reply.value = value;
        });
        return reply;
      },
      syncReply: (appId: string) =>
        ask<unknown>("apps:yjs:sync", { appId, syncMessage: Y.encodeStateVector(new Y.Doc()) }),
      syncReplyInto: (appId: string) => sync(appId),
      coldUpdate: (appId: string) =>
        ask<{ syncMessage: Uint8Array }>("apps:yjs:sync", {
          appId,
          syncMessage: Y.encodeStateVector(new Y.Doc()),
        }).syncMessage,
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

export const forgedUpdate = (clientID: number, clock: number, key: string): Uint8Array => {
  const forger = new Y.Doc();
  forger.clientID = clientID;
  for (let index = 0; index < clock; index += 1) forger.getMap("pad").set(`p${index}`, index);
  const before = Y.encodeStateVector(forger);
  forger.getMap("shapes").set(key, true);
  return Y.encodeStateAsUpdate(forger, before);
};

export const presencePacket = (clientIds: number[], clock = 1, state = "{}"): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clientIds.length);
  for (const clientId of clientIds) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, state);
  }
  return encoding.toUint8Array(encoder);
};

export const awarenessPacket = (entries: { client: number; clock: number; state: string }[]): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.client);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.state);
  }
  return encoding.toUint8Array(encoder);
};

export const authoredBy = (clientIds: number[]): Uint8Array =>
  Y.mergeUpdates(
    clientIds.map((clientId) => {
      const author = new Y.Doc();
      author.clientID = clientId;
      author.getMap("shapes").set(`s${clientId}`, true);
      return Y.encodeStateAsUpdate(author);
    }),
  );

export type RawId = { client: number; clock: number };
export type RawStruct = {
  client: number;
  clock: number;
  origin?: RawId;
  right?: RawId;
  parent?: string | RawId;
  key?: string;
  value?: unknown;
  type?: "array" | "map";
};

export const writeId = (encoder: encoding.Encoder, id: RawId) => {
  encoding.writeVarUint(encoder, id.client);
  encoding.writeVarUint(encoder, id.clock);
};

export const rawUpdate = (structs: RawStruct[], deletes: Array<RawId & { len: number }> = []): Uint8Array => {
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

export const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const textBy = (doc: Y.Doc, text: string): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  doc.getText("t").insert(doc.getText("t").length, text);
  return Y.encodeStateAsUpdate(doc, before);
};

export const clockOf = (doc: Y.Doc): number =>
  Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;

export const writePage = (doc: Y.Doc, strokes: string[]): Uint8Array => {
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

export const pageOf = (update: Uint8Array): string[] => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const page = doc.getMap("board").get("page");
  return page instanceof Y.Map ? Array.from(page.keys()).sort() : [];
};

export const lastState = (broadcasts: Sent[]): AppsState =>
  broadcasts.filter((sent) => sent.event === "apps:state").at(-1)!.payload as AppsState;
