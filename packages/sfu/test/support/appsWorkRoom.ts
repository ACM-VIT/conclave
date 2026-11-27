import * as Y from "yjs";
import { vi } from "vitest";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import { RoomApps } from "../../server/roomApps.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createConnectionContext } from "../../server/socket/context.js";
import { registerAppsHandlers } from "../../server/socket/handlers/appsHandlers.js";
import { RATE_LIMITS } from "../../server/socket/rateLimit.js";
import { createSfuState } from "../../server/state.js";
import type { AppsState } from "../../types.js";

export const BOARD = "whiteboard";
export const { capacity: UPDATE_BURST, refillPerSec: UPDATES_PER_SECOND } = RATE_LIMITS.appsYjsUpdate;

type Handler = (...args: unknown[]) => unknown;

export type Received = { event: string; payload: unknown; at: number; direct: boolean; room: string };

export type WriteCall = {
  socketId: string;
  participant: string;
  at: number;
  appId: string;
  generation: number | null;
  writeIds: string[];
  update: Uint8Array;
  result: string | null;
};

export type Command = {
  peer: string;
  kind: "open" | "close" | "discard" | "lock" | "unlock";
  appId?: string;
  sentAt: number;
  ackedAt: number | null;
  reply: unknown;
};

export type SyncRecord = { peer: string; sentAt: number; answeredAt: number | null; reply: unknown };

export type SentWrite = {
  peer: string;
  socketId: string;
  writeId: string;
  sentAt: number;
  update: Uint8Array;
};

export const structsIn = (update: Uint8Array): (Y.Item | Y.GC | Y.Skip)[] => {
  try {
    return Y.decodeUpdate(update).structs;
  } catch {
    return [];
  }
};

export const writeIdsIn = (update: Uint8Array): string[] =>
  structsIn(update).flatMap((struct) =>
    struct instanceof Y.Item && struct.parentSub?.startsWith("w") ? [struct.parentSub] : [],
  );

export const recordWrites = (): WriteCall[] => {
  const calls: WriteCall[] = [];
  const original: (this: RoomApps, ...args: Parameters<RoomApps["write"]>) => ReturnType<RoomApps["write"]> =
    Reflect.get(RoomApps.prototype, "write");
  vi.spyOn(RoomApps.prototype, "write").mockImplementation(function (
    this: RoomApps,
    ...args: Parameters<RoomApps["write"]>
  ) {
    const generation = this.snapshot().docGeneration;
    const result = original.apply(this, args);
    const [appId, participant, update, , options] = args;
    calls.push({
      socketId: String(options?.origin ?? ""),
      participant,
      at: Date.now(),
      appId,
      generation,
      writeIds: writeIdsIn(update),
      update,
      result,
    });
    return result;
  });
  return calls;
};

export const isBlank = (entry: Received): boolean =>
  entry.event === "apps:state" && (entry.payload as AppsState).activeAppId === null;

export const makeWorkRooms = () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "apps-work", instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  const rooms = new Map<string, Room>();
  const roomFor = (id: string): Room => {
    const existing = rooms.get(id);
    if (existing) return existing;
    const room = new Room({
      id,
      clientId: "conclave",
      workerPid: null,
      router: { closed: false, close: () => {} } as unknown as Router,
    });
    state.rooms.set(room.channelId, room);
    rooms.set(id, room);
    return room;
  };
  const peers = new Map<string, Peer>();
  const commands: Command[] = [];
  const syncs: SyncRecord[] = [];
  const sent: SentWrite[] = [];
  let writeSerial = 0;
  const io = {
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) => {
        for (const peer of peers.values()) if (peer.channel === channel) peer.deliver(event, payload, false);
      },
    }),
  } as unknown as SocketIOServer;

  type Peer = ReturnType<typeof connect>;

  function connect(id: string, options: { host?: boolean; legacy?: boolean; room?: string } = {}) {
    const handlers = new Map<string, Handler>();
    const received: Received[] = [];
    const participant = id.split("#")[0];
    const socketId = `socket-${id}`;
    let connected = true;
    let roomId = options.room ?? "room";
    let room = roomFor(roomId);
    let doc = new Y.Doc();
    let replica = 0;
    let view = "";
    let stageGeneration: number | null = null;
    let syncedGeneration: number | null | undefined;
    let needsSync = false;
    let syncInFlight = false;
    let pushAfterSync: Uint8Array | null = null;
    let caughtUp = false;
    const freshCopy = () => {
      doc = new Y.Doc();
      replica += 1;
      caughtUp = false;
      needsSync = room.apps.activeAppId === BOARD;
      pushAfterSync = null;
    };
    const deliver = (event: string, payload: unknown, direct: boolean) => {
      if (!connected) return;
      received.push({ event, payload, at: Date.now(), direct, room: roomId });
      if (event === "apps:state") {
        const stage = payload as AppsState;
        stageGeneration = stage.docGeneration;
        const next = options.legacy ? `${stage.activeAppId}` : `${stage.activeAppId}:${stage.docGeneration}`;
        if (next !== view) {
          view = next;
          freshCopy();
          needsSync = stage.activeAppId === BOARD;
        }
      } else if (event === "apps:yjs:update") {
        Y.applyUpdate(doc, (payload as { update: Uint8Array }).update, "remote");
      } else if (event === "apps:yjs:refused") {
        if ((payload as { replicaId: string }).replicaId === `copy-${replica}`) freshCopy();
      }
    };
    const socket = {
      id: socketId,
      data: { user: {} },
      get connected() {
        return connected;
      },
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: (event: string, payload: unknown) => {
        deliver(event, payload, true);
        return true;
      },
      to: (channel: string) => ({
        emit: (event: string, payload: unknown) => {
          for (const other of peers.values()) {
            if (other.id !== id && other.channel === channel) other.deliver(event, payload, false);
          }
        },
      }),
      join: () => {},
      leave: () => {},
      disconnect: () => {},
    } as unknown as Socket;
    const seat = (target: Room) => {
      const client = options.host ? new Admin({ id, socket }) : new Client({ id, socket });
      target.addClient(client);
      target.setUserIdentity(id, participant, participant);
      return client;
    };
    const context = createConnectionContext(io, socket, state);
    context.currentRoom = room;
    context.currentClient = seat(room);
    registerAppsHandlers(context);
    const fire = (event: string, ...args: unknown[]) => handlers.get(event)!(...args);
    if (room.apps.activeAppId !== null) {
      fire("apps:getState", (stage: AppsState) => deliver("apps:state", stage, false));
    }
    const replicaIdNow = () => (options.legacy ? undefined : `copy-${replica}`);
    const sendUpdate = (update: Uint8Array, replicaId: string | undefined = replicaIdNow()) =>
      fire("apps:yjs:update", { appId: BOARD, update, replicaId });
    const command = (kind: Command["kind"], appId?: string, expectedRevision?: number) => {
      const record: Command = { peer: id, kind, appId, sentAt: Date.now(), ackedAt: null, reply: undefined };
      commands.push(record);
      const done = (reply: unknown) => {
        record.ackedAt = Date.now();
        record.reply = reply;
      };
      if (kind === "lock" || kind === "unlock") fire("apps:lock", { locked: kind === "lock", expectedRevision }, done);
      else fire(`apps:${kind}`, { appId, expectedRevision }, done);
      return record;
    };
    const peer = {
      id,
      socketId,
      participant,
      legacy: options.legacy === true,
      host: options.host === true,
      received,
      deliver,
      get connected() {
        return connected;
      },
      get channel() {
        return room.channelId;
      },
      get roomId() {
        return roomId;
      },
      get doc() {
        return doc;
      },
      get stale() {
        return stageGeneration !== null && syncedGeneration !== stageGeneration;
      },
      get synced() {
        return !needsSync && !syncInFlight && view !== "" && !peer.stale;
      },
      get caughtUp() {
        return caughtUp && peer.synced;
      },
      write: (count: number, options: { blind?: boolean; replicaId?: string } = {}): string[] => {
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const before = Y.encodeStateVector(doc);
          const writeId = `w${(writeSerial += 1)}`;
          doc.transact(() => {
            doc.getMap("m").set(writeId, writeSerial);
            if (options.blind && index === 0) doc.getMap("m").set("shared", new Y.Map());
          });
          const update = Y.encodeStateAsUpdate(doc, before);
          sent.push({ peer: id, socketId, writeId, sentAt: Date.now(), update });
          ids.push(writeId);
          sendUpdate(update, options.replicaId ?? replicaIdNow());
        }
        return ids;
      },
      sendRaw: (update: Uint8Array, replicaId: string | undefined = replicaIdNow()) => sendUpdate(update, replicaId),
      sendPayload: (update: unknown, replicaId: string | undefined = replicaIdNow()) =>
        fire("apps:yjs:update", { appId: BOARD, update, replicaId }),
      syncPayload: (syncMessage: unknown): SyncRecord => {
        const record: SyncRecord = { peer: id, sentAt: Date.now(), answeredAt: null, reply: undefined };
        syncs.push(record);
        fire("apps:yjs:sync", { appId: BOARD, canRetry: true, syncMessage }, (reply: unknown) => {
          record.answeredAt = Date.now();
          record.reply = reply;
        });
        return record;
      },
      awarenessPayload: (awarenessUpdate: unknown) => fire("apps:awareness", { appId: BOARD, awarenessUpdate }),
      freshCopy,
      sync: (valid = true): SyncRecord => {
        const record: SyncRecord = { peer: id, sentAt: Date.now(), answeredAt: null, reply: undefined };
        syncs.push(record);
        if (!valid) {
          fire("apps:yjs:sync", { appId: BOARD, canRetry: true, syncMessage: "%%%" }, (reply: unknown) => {
            record.answeredAt = Date.now();
            record.reply = reply;
          });
          return record;
        }
        const copy = replica;
        syncInFlight = true;
        needsSync = false;
        fire("apps:yjs:sync", { appId: BOARD, canRetry: true, syncMessage: Y.encodeStateVector(doc) }, (reply: unknown) => {
          record.answeredAt = Date.now();
          record.reply = reply;
          syncInFlight = false;
          if (copy === replica) syncedGeneration = stageGeneration;
          const answer = reply as { syncMessage?: Uint8Array; stateVector?: Uint8Array };
          if (copy !== replica || !answer?.syncMessage) return;
          Y.applyUpdate(doc, answer.syncMessage, "remote");
          caughtUp = true;
          if (!answer.stateVector) return;
          const known = Y.decodeStateVector(answer.stateVector);
          const ahead = [...Y.decodeStateVector(Y.encodeStateVector(doc))].some(
            ([client, clock]) => clock > (known.get(client) ?? 0),
          );
          pushAfterSync = ahead ? Y.encodeStateAsUpdate(doc, answer.stateVector) : null;
        });
        return record;
      },
      react: () => {
        if (!connected) return;
        if (pushAfterSync) {
          const diff = pushAfterSync;
          pushAfterSync = null;
          sendUpdate(diff);
        }
        if (needsSync && !syncInFlight) peer.sync();
      },
      command,
      rejoinSeat: () => {
        context.currentClient = seat(room);
        freshCopy();
        peer.sync();
      },
      leave: () => {
        handlers.get("disconnecting")?.();
        connected = false;
        room.removeClient(id);
        for (const removal of room.apps.clearUserAwareness(id)) void removal;
      },
      switchRoom: (next: string) => {
        room.removeClient(id);
        roomId = next;
        room = roomFor(next);
        context.currentRoom = room;
        context.currentClient = seat(room);
        view = "";
        freshCopy();
      },
      directStates: () => received.filter((entry) => entry.event === "apps:state" && entry.direct),
    };
    peers.set(id, peer);
    return peer;
  }

  return { state, rooms, roomFor, peers, commands, syncs, sent, connect };
};
