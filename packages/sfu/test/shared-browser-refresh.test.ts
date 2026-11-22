import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";

const FIRST_URL = "https://browser.example/novnc/6080/vnc_lite.html?autoconnect=true#&password=first111";
const SECOND_URL = "https://browser.example/novnc/6080/vnc_lite.html?autoconnect=true#&password=second22";

const service = vi.hoisted(() => ({
  sessionsGate: null as null | Promise<void>,
  sessionsResponse: {} as { session?: { noVncUrl?: string; currentUrl?: string } },
}));

vi.mock("../server/browserServiceClient.js", () => ({
  getBrowserServiceCapabilities: vi.fn(async () => ({ audio: false, video: false, provider: "chromium" })),
  describeBrowserServiceError: (error: unknown) => String(error),
  isMissingBrowserSessionError: () => false,
  callBrowserService: vi.fn(async (path: string) => {
    if (path === "/launch") return { success: true, session: { noVncUrl: FIRST_URL, provider: "chromium" } };
    if (path === "/navigate") return { success: true, session: { noVncUrl: SECOND_URL, provider: "chromium" } };
    if (path.startsWith("/sessions/")) {
      await service.sessionsGate;
      return service.sessionsResponse;
    }
    return { success: true };
  }),
}));

const { Admin } = await import("../config/classes/Admin.js");
const { Room } = await import("../config/classes/Room.js");
const { createConnectionContext } = await import("../server/socket/context.js");
const { registerSharedBrowserHandlers, getBrowserState } =
  await import("../server/socket/handlers/sharedBrowserHandlers.js");
const { createSfuState } = await import("../server/state.js");
const { LocalRoomRegistry } = await import("../server/roomRegistry.js");

type Handler = (...args: never[]) => unknown;

const setup = (roomId: string) => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "browser-refresh-test", instanceUrl: "http://localhost", ttlMs: 45000 }),
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
  const roomEmit = vi.fn();
  const io = { to: () => ({ emit: roomEmit }) } as unknown as SocketIOServer;
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
  return { room, call, roomEmit };
};

const gateSessions = () => {
  let release!: () => void;
  service.sessionsGate = new Promise<void>((resolve) => { release = resolve; });
  return () => release();
};

afterEach(() => {
  service.sessionsGate = null;
  service.sessionsResponse = {};
});

describe("shared browser state refresh", () => {
  it("keeps the navigated session when an older refresh answers late", async () => {
    const h = setup("refresh-stale-url");
    await h.call("browser:launch", { url: "https://example.com" }).done;
    service.sessionsResponse = { session: { noVncUrl: FIRST_URL, currentUrl: "https://example.com/" } };
    const release = gateSessions();

    const refresh = h.call("browser:getState");
    await h.call("browser:navigate", { url: "https://example.org" }).done;
    release();
    await refresh.done;

    expect(refresh.ack).toHaveBeenCalledWith(expect.objectContaining({ active: true, noVncUrl: SECOND_URL }));
    expect(getBrowserState(h.room.channelId).noVncUrl).toBe(SECOND_URL);
  });

  it("does not close the browser when the replaced session is gone by the time the refresh answers", async () => {
    const h = setup("refresh-missing");
    await h.call("browser:launch", { url: "https://example.com" }).done;
    const release = gateSessions();

    const refresh = h.call("browser:getState");
    await h.call("browser:navigate", { url: "https://example.org" }).done;
    release();
    await refresh.done;

    expect(refresh.ack).toHaveBeenCalledWith(expect.objectContaining({ active: true, noVncUrl: SECOND_URL }));
    expect(getBrowserState(h.room.channelId).active).toBe(true);
    expect(h.roomEmit).not.toHaveBeenCalledWith("browser:closed", expect.anything());
  });

  it("still applies a refresh that nothing overtook", async () => {
    const h = setup("refresh-current");
    await h.call("browser:launch", { url: "https://example.com" }).done;
    service.sessionsResponse = { session: { noVncUrl: FIRST_URL, currentUrl: "https://example.com/after-click" } };

    const refresh = h.call("browser:getState");
    await refresh.done;

    expect(refresh.ack).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/after-click" }));
    expect(getBrowserState(h.room.channelId).url).toBe("https://example.com/after-click");
  });
});
