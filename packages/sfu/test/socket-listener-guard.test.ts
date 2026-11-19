import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { guardSocketListeners } from "../server/socket/guardListeners.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAppsHandlers } from "../server/socket/handlers/appsHandlers.js";
import { registerSharedBrowserHandlers } from "../server/socket/handlers/sharedBrowserHandlers.js";
import { createSfuState } from "../server/state.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { Server as SocketIOServer } from "socket.io";

type Listener = (...args: unknown[]) => unknown;

const makeSocket = () => {
  const listeners = new Map<string, Listener>();
  const socket = {
    id: "s1",
    data: { user: {} },
    on(event: string, listener: Listener) {
      listeners.set(event, listener);
      return socket;
    },
    emit: vi.fn(),
  } as unknown as Socket;
  guardSocketListeners(socket);
  return { socket, listeners };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("socket listener guard", () => {
  it("contains a throwing handler and answers its ack", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { socket, listeners } = makeSocket();
    socket.on("boom", () => { throw new TypeError("bad payload"); });
    const ack = vi.fn();
    expect(() => listeners.get("boom")!(null, ack)).not.toThrow();
    expect(ack).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("contains a rejecting async handler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { socket, listeners } = makeSocket();
      socket.on("boom", async () => { throw new Error("async failure"); });
      const ack = vi.fn();
      listeners.get("boom")!(ack);
      await flush();
      expect(ack).toHaveBeenCalledWith({ error: "Internal server error" });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("survives the getState packets sent without an ack callback", async () => {
    const { socket, listeners } = makeSocket();
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "guard", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    const context = createConnectionContext({} as SocketIOServer, socket, state);
    registerAppsHandlers(context);
    registerSharedBrowserHandlers(context);
    expect(() => listeners.get("apps:getState")!()).not.toThrow();
    expect(() => listeners.get("apps:getState")!(1)).not.toThrow();
    await expect(Promise.resolve(listeners.get("browser:getState")!())).resolves.toBeUndefined();
  });
});
