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

describe("app document size", () => {
  it("stops growing a document at the size a sync can still deliver", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listeners = new Map<string, Listener>();
    const socket = {
      id: "s1",
      data: { user: {} },
      on: (event: string, listener: Listener) => { listeners.set(event, listener); return socket; },
      to: () => ({ emit: vi.fn() }),
      emit: vi.fn(),
    } as unknown as Socket;
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "apps", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router: {} as Router });
    state.rooms.set(room.channelId, room);
    const admin = new Admin({ id: "a#1", socket });
    room.addClient(admin);
    room.appsState.activeAppId = "board";
    const context = createConnectionContext({ to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer, socket, state);
    context.currentRoom = room;
    context.currentClient = admin;
    registerAppsHandlers(context);

    const attacker = new Y.Doc();
    const text = attacker.getText("t");
    const chunk = "x".repeat(200 * 1024);
    for (let index = 0; index < 20; index += 1) {
      const before = Y.encodeStateVector(attacker);
      text.insert(text.length, chunk);
      const update = Y.encodeStateAsUpdate(attacker, before);
      listeners.get("apps:yjs:update")!({ appId: "board", update });
    }

    const serverDoc = room.getOrCreateAppDoc("board");
    expect(Y.encodeStateAsUpdate(serverDoc).length).toBeLessThanOrEqual(1024 * 1024);
    expect(serverDoc.getText("t").length).toBeGreaterThan(0);
  });
});
