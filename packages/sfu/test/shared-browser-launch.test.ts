import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";

const service = vi.hoisted(() => ({
  launchGate: null as null | Promise<void>,
  calls: [] as string[],
}));

vi.mock("../server/browserServiceClient.js", () => ({
  getBrowserServiceCapabilities: vi.fn(async () => ({ audio: false, video: false, provider: "chromium" })),
  describeBrowserServiceError: (error: unknown) => String(error),
  callBrowserService: vi.fn(async (path: string) => {
    service.calls.push(path);
    if (path === "/launch") {
      await service.launchGate;
      return { success: true, session: { noVncUrl: "http://vnc.test", provider: "chromium" } };
    }
    return { success: true };
  }),
}));

const { Admin } = await import("../config/classes/Admin.js");
const { Room } = await import("../config/classes/Room.js");
const { createConnectionContext } = await import("../server/socket/context.js");
const { registerSharedBrowserHandlers, getBrowserState, cleanupRoomBrowser } =
  await import("../server/socket/handlers/sharedBrowserHandlers.js");
const { createSfuState } = await import("../server/state.js");
const { LocalRoomRegistry } = await import("../server/roomRegistry.js");

type Handler = (...args: never[]) => unknown;

const setup = (roomId: string) => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "browser-test", instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  const room = new Room({ id: roomId, clientId: "conclave", workerPid: null, router: {} as Router });
  state.rooms.set(room.channelId, room);
  const handlers = new Map<string, Handler>();
  const socket = {
    id: `${roomId}-admin`,
    data: { user: {} },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: vi.fn(),
  } as unknown as Socket;
  const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;
  const admin = new Admin({ id: "host#1", socket });
  room.addClient(admin);
  const context = createConnectionContext(io, socket, state);
  context.currentRoom = room;
  context.currentClient = admin;
  registerSharedBrowserHandlers(context);
  const call = (event: string, ...args: unknown[]) => {
    const ack = vi.fn();
    const done = handlers.get(event)!(...[...args, ack] as never[]) as Promise<void>;
    return { ack, done };
  };
  return { room, call };
};

afterEach(() => {
  service.calls.length = 0;
  service.launchGate = null;
});

describe("shared browser launch lifecycle", () => {
  it("refuses a second launch while the first is still in flight", async () => {
    let release!: () => void;
    service.launchGate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup("double");
    const first = h.call("browser:launch", { url: "https://example.com" });
    await vi.waitFor(() => expect(service.calls).toContain("/launch"));
    const second = h.call("browser:launch", { url: "https://example.org" });
    await second.done;
    expect(second.ack).toHaveBeenCalledWith({ error: "Browser is already launching" });
    release();
    await first.done;
    expect(first.ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(service.calls.filter((path) => path === "/launch")).toHaveLength(1);
  });

  it("honours a close sent while the launch is in flight", async () => {
    let release!: () => void;
    service.launchGate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup("close-during");
    const launch = h.call("browser:launch", { url: "https://example.com" });
    await vi.waitFor(() => expect(service.calls).toContain("/launch"));
    const close = h.call("browser:close");
    await close.done;
    expect(close.ack).toHaveBeenCalledWith({ success: true });
    release();
    await launch.done;

    expect(launch.ack).toHaveBeenCalledWith({ error: "Browser launch was cancelled" });
    expect(service.calls).toEqual(["/launch", "/close"]);
    expect(getBrowserState(h.room.channelId).active).toBe(false);
  });

  it("closes the session when the room closes during the launch", async () => {
    let release!: () => void;
    service.launchGate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup("room-closed");
    const launch = h.call("browser:launch", { url: "https://example.com" });
    await vi.waitFor(() => expect(service.calls).toContain("/launch"));
    await cleanupRoomBrowser(h.room.channelId);
    release();
    await launch.done;

    expect(launch.ack).toHaveBeenCalledWith({ error: "Browser launch was cancelled" });
    expect(service.calls).toContain("/close");
    expect(getBrowserState(h.room.channelId).active).toBe(false);
  });
});
