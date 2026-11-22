import { vi } from "vitest";
import * as Y from "yjs";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import { Room } from "../../config/classes/Room.js";
import type { AppDocumentPool } from "../../server/apps/documents/pool.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createConnectionContext } from "../../server/socket/context.js";
import { registerAppsHandlers } from "../../server/socket/handlers/appsHandlers.js";
import { createSfuState } from "../../server/state.js";
import type { AppsRefusedData, AppsSyncError, AppsSyncResponse } from "../../types.js";

type Listener = (...args: unknown[]) => unknown;

export const edit = (doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  change(doc.getText("t"));
  return Y.encodeStateAsUpdate(doc, before);
};

export const inAppRoom = (pool: AppDocumentPool, id: string) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const listeners = new Map<string, Listener>();
  const relayed: Uint8Array[] = [];
  const refused: AppsRefusedData[] = [];
  const socket = {
    id: `s-${id}`,
    data: { user: {} },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return socket;
    },
    to: () => ({
      emit: (event: string, payload: { update: Uint8Array }) => {
        if (event === "apps:yjs:update") relayed.push(payload.update);
      },
    }),
    emit: (event: string, payload: AppsRefusedData) => {
      if (event === "apps:yjs:refused") refused.push(payload);
    },
  } as unknown as Socket;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: id, instanceUrl: "http://localhost", ttlMs: 45000 }),
    appDocuments: pool,
  });
  const room = new Room({ id, clientId: "conclave", workerPid: null, router: {} as Router });
  state.rooms.set(room.channelId, room);
  const admin = new Admin({ id: `a#${id}`, socket });
  room.addClient(admin);
  const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;
  const context = createConnectionContext(io, socket, state);
  context.currentRoom = room;
  context.currentClient = admin;
  registerAppsHandlers(context);
  const call = <T>(event: string, ...args: unknown[]) =>
    new Promise<T>((resolve) => listeners.get(event)!(...args, resolve));
  const requestSync = (holder: Y.Doc, canRetry = true) =>
    call<AppsSyncResponse | AppsSyncError>("apps:yjs:sync", {
      appId: "board",
      syncMessage: Y.encodeStateVector(holder),
      canRetry,
    });
  const syncFrom = async (holder: Y.Doc) => {
    const response = await requestSync(holder);
    if (!("syncMessage" in response)) throw new Error(response.error);
    return response;
  };
  const joinDocument = async () => {
    const doc = new Y.Doc();
    const { syncMessage } = await syncFrom(doc);
    Y.applyUpdate(doc, syncMessage);
    return { doc, encodedBytes: syncMessage.length };
  };
  return {
    relayed,
    refused,
    open: () => call("apps:open", { appId: "board" }),
    close: () => call("apps:close"),
    send: (update: Uint8Array, replicaId?: string) =>
      listeners.get("apps:yjs:update")!({ appId: "board", update, replicaId }),
    disconnect: () => listeners.get("disconnect")!(),
    requestSync,
    syncFrom,
    joinDocument,
    join: async () => (await joinDocument()).doc.getText("t").toString(),
  };
};
