import { vi } from "vitest";
import * as Y from "yjs";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import { Room } from "../../config/classes/Room.js";
import type { AppDocumentPool } from "../../server/apps/documents/pool.js";
import type { StagingBudget } from "../../server/apps/documents/staging.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createConnectionContext, type ConnectionContext } from "../../server/socket/context.js";
import { registerAppsHandlers } from "../../server/socket/handlers/appsHandlers.js";
import { createSfuState, type SfuState } from "../../server/state.js";
import type { AppsRefusedData, AppsSyncError, AppsSyncResponse } from "../../types.js";

type Listener = (...args: unknown[]) => unknown;
type Received = { event: string; payload: unknown };
type Member = { id: string; inbox: Received[] };
type Hub = Map<string, Set<Member>>;

export const edit = (doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  change(doc.getText("t"));
  return Y.encodeStateAsUpdate(doc, before);
};

const fakeSocket = (id: string, hub: Hub, relayed?: Uint8Array[]) => {
  const listeners = new Map<string, Listener>();
  const member: Member = { id, inbox: [] };
  const rooms = new Set<string>();
  const deliver = (target: string, except: string | null, event: string, payload: unknown) => {
    if (event === "apps:yjs:update") relayed?.push((payload as { update: Uint8Array }).update);
    for (const other of hub.get(target) ?? []) {
      if (other.id === id) continue;
      if (except !== null && hub.get(except)?.has(other)) continue;
      other.inbox.push({ event, payload });
    }
  };
  const socket = {
    id,
    connected: true,
    data: { user: {} },
    rooms,
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return socket;
    },
    join: (target: string) => {
      rooms.add(target);
      const members = hub.get(target) ?? new Set<Member>();
      members.add(member);
      hub.set(target, members);
    },
    leave: (target: string) => {
      rooms.delete(target);
      hub.get(target)?.delete(member);
    },
    to: (target: string) => ({
      emit: (event: string, payload: unknown) => deliver(target, null, event, payload),
      except: (other: string) => ({ emit: (event: string, payload: unknown) => deliver(target, other, event, payload) }),
    }),
    emit: (event: string, payload: unknown) => {
      member.inbox.push({ event, payload });
    },
  } as unknown as Socket;
  const call = <T>(event: string, ...args: unknown[]) => new Promise<T>((resolve) => listeners.get(event)!(...args, resolve));
  return { socket, member, listeners, call };
};

const enter = (state: SfuState, room: Room, joiner: ReturnType<typeof fakeSocket>, clientId: string): ConnectionContext => {
  const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;
  const client = new Admin({ id: clientId, socket: joiner.socket });
  room.addClient(client);
  void joiner.socket.join(room.channelId);
  const context = createConnectionContext(io, joiner.socket, state);
  context.currentRoom = room;
  context.currentClient = client;
  return context;
};

const newRoom = (state: SfuState, id: string): Room => {
  const room = new Room({ id, clientId: "conclave", workerPid: null, router: { closed: true } as Router, appDocuments: state.appDocuments });
  state.rooms.set(room.channelId, room);
  return room;
};

export const inAppRoom = (pool: AppDocumentPool, id: string, options: { appChangeStaging?: StagingBudget; appId?: string; wheelFormat?: 2 } = {}) => {
  const { appId = "board" } = options;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const hub: Hub = new Map();
  const relayed: Uint8Array[] = [];
  const self = fakeSocket(`s-${id}`, hub, relayed);
  const { listeners, call } = self;
  const refused = (): AppsRefusedData[] =>
    self.member.inbox.filter(({ event }) => event === "apps:yjs:refused").map(({ payload }) => payload as AppsRefusedData);
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: id, instanceUrl: "http://localhost", ttlMs: 45000 }),
    appDocuments: pool,
    appChangeStaging: options.appChangeStaging,
  });
  const room = newRoom(state, id);
  const context = enter(state, room, self, `a#${id}`);
  registerAppsHandlers(context);
  const requestSync = (holder: Y.Doc | Uint8Array, canRetry = true, wholeChanges = false, wheelFormat = options.wheelFormat) =>
    call<AppsSyncResponse | AppsSyncError>("apps:yjs:sync", {
      appId,
      syncMessage: holder instanceof Y.Doc ? Y.encodeStateVector(holder) : holder,
      canRetry,
      ...(wholeChanges ? { wholeChanges } : {}),
      wheelFormat,
    });
  const syncFrom = async (holder: Y.Doc, wheelFormat?: 2) => {
    const response = await requestSync(holder, true, false, wheelFormat);
    if (!("syncMessage" in response)) throw new Error(response.error);
    return response;
  };
  const joinDocument = async (wheelFormat?: 2) => {
    const doc = new Y.Doc();
    const { syncMessage } = await syncFrom(doc, wheelFormat);
    Y.applyUpdate(doc, syncMessage);
    return { doc, encodedBytes: syncMessage.length };
  };
  let peers = 0;
  const peer = async ({ encoding = "binary", declares = false, syncs = true, wheelFormat = options.wheelFormat }: { encoding?: "binary" | "base64"; declares?: boolean; syncs?: boolean; wheelFormat?: 2 } = {}) => {
    peers += 1;
    const joiner = fakeSocket(`s-${id}-peer-${peers}`, hub);
    registerAppsHandlers(enter(state, context.currentRoom ?? room, joiner, `p${peers}#${id}`));
    const sync = (doc: Y.Doc) => {
      const vector = Y.encodeStateVector(doc);
      return joiner.call<AppsSyncResponse | AppsSyncError>("apps:yjs:sync", {
        appId,
        syncMessage: encoding === "base64" ? Buffer.from(vector).toString("base64") : vector,
        canRetry: true,
        ...(declares ? { wholeChanges: true } : {}),
        wheelFormat,
      });
    };
    if (syncs) {
      const doc = new Y.Doc();
      await sync(doc);
      doc.destroy();
    }
    return {
      sync,
      inbox: joiner.member.inbox,
      settle: () =>
        joiner.call<AppsSyncResponse | AppsSyncError>("apps:yjs:sync", {
          appId, syncMessage: Y.encodeStateVector(new Y.Doc()), canRetry: true, wheelFormat,
        }),
      send: (update: Uint8Array, replicaId: string, part?: unknown) =>
        joiner.listeners.get("apps:yjs:update")!({ appId, update, replicaId, ...(part === undefined ? {} : { part }) }),
      acknowledged: (update: Uint8Array, replicaId?: string, part?: unknown) =>
        joiner.call("apps:yjs:update", { appId, update, replicaId, ...(part === undefined ? {} : { part }) }),
      updates: () => joiner.member.inbox.filter(({ event }) => event === "apps:yjs:update").map(({ payload }) => (payload as { update: Uint8Array }).update),
      states: () => joiner.member.inbox.filter(({ event }) => event === "apps:state").map(({ payload }) => (payload as { activeAppId: string | null }).activeAppId),
    };
  };
  const strangerIn = (otherId: string) => {
    const joiner = fakeSocket(`s-stranger-${otherId}`, hub);
    enter(state, newRoom(state, otherId), joiner, `x#${otherId}`);
    return { inbox: joiner.member.inbox };
  };
  const beginMove = () => listeners.get("joinRoom")?.({}, () => undefined);
  const finishMove = async (otherId: string) => {
    const previous = context.currentRoom!;
    previous.removeClient(context.currentClient!.id);
    void self.socket.leave(previous.channelId);
    context.currentRoom = null;
    context.currentClient = null;
    const other = newRoom(state, otherId);
    const moved = new Admin({ id: `a#${id}`, socket: self.socket });
    other.addClient(moved);
    void self.socket.join(other.channelId);
    context.currentRoom = other;
    context.currentClient = moved;
    await call("apps:open", { appId });
    await requestSync(new Y.Doc(), true, true);
    return other;
  };
  return {
    state,
    room,
    inbox: self.member.inbox,
    relayed,
    demote: () => {
      const client = context.currentClient!;
      room.setUserIdentity(client.id, client.id, client.id);
      room.demoteToParticipant(client.id);
    },
    promote: () => room.grantHost(context.currentClient!.id, "promoted"),
    reseat: () => {
      const id = context.currentClient!.id;
      room.removeClient(id);
      const replacement = new Admin({ id, socket: self.socket });
      room.addClient(replacement);
      context.currentClient = replacement;
    },
    lock: (locked = true) => call<{ success: boolean }>("apps:lock", { locked }),
    get refused() {
      return refused();
    },
    peer,
    strangerIn,
    getState: () => call("apps:getState"),
    open: async () => {
      const response = await call("apps:open", { appId });
      await requestSync(new Y.Doc(), true, true);
      return response;
    },
    present: (id: string, expectedRevision?: number) => call<{ success: boolean; code?: string }>("apps:open", { appId: id, expectedRevision }),
    close: (expected?: { expectedRevision: number; expectedRoomId: string }) =>
      expected ? call<{ success: boolean }>("apps:close", expected) : call<{ success: boolean }>("apps:close"),
    clear: () => call("apps:discard", { appId, expectedRevision: context.currentRoom!.apps.stageRevision }),
    send: (update: Uint8Array, replicaId?: string, part?: unknown) =>
      listeners.get("apps:yjs:update")!({ appId, update, replicaId, ...(part === undefined ? {} : { part }) }),
    sendList: (updates: unknown, replicaId?: string) => listeners.get("apps:yjs:update")!({ appId, updates, replicaId }),
    acknowledged: (payload: { update?: Uint8Array | string; updates?: unknown; part?: unknown }, replicaId?: string) =>
      new Promise<{ receipt: unknown; inbox: Received[]; relayed: number }>((resolve) => {
        listeners.get("apps:yjs:update")!({ appId, replicaId, ...payload }, (receipt: unknown) =>
          resolve({ receipt, inbox: [...self.member.inbox], relayed: relayed.length }),
        );
      }),
    disconnect: () => listeners.get("disconnect")!(),
    leave: () => {
      context.currentRoom = null;
    },
    beginMove,
    finishMove,
    moveTo: async (otherId: string, { asksToJoin = true }: { asksToJoin?: boolean } = {}) => {
      if (asksToJoin) beginMove();
      return finishMove(otherId);
    },
    requestSync,
    syncFrom,
    joinDocument,
    join: async () => (await joinDocument()).doc.getText("t").toString(),
  };
};
