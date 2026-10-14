import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router, WebRtcTransport } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { kickClient } from "../server/admin/controlPlane.js";
import { SUPER_ADMIN_REMOVAL_ERROR } from "../server/admin/moderation.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAdminHandlers } from "../server/socket/handlers/adminHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig, setCustomWebinarLinkSlug } from "../server/webinar.js";

type Handler = (...args: never[]) => void | Promise<void>;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  ));
});

const makeSocket = (user: SfuAuthPayload = {}) => {
  const handlers = new Map<string, Handler>();
  const emit = vi.fn();
  const disconnect = vi.fn();
  const socket = {
    id: "test-socket",
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect,
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers, emit, disconnect };
};

const makeHarness = ({
  actorSuperAdmin = false,
  targetClaims = { isSuperAdmin: true },
  targetAdmin = true,
}: {
  actorSuperAdmin?: boolean;
  targetClaims?: SfuAuthPayload;
  targetAdmin?: boolean;
} = {}) => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "moderation-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const room = new Room({
    id: "room",
    clientId: "conclave",
    workerPid: null,
    router: {} as Router,
  });
  state.rooms.set(room.channelId, room);
  const broadcast = vi.fn();
  const io = { to: () => ({ emit: broadcast }) } as unknown as SocketIOServer;
  const actorSocket = makeSocket({ isSuperAdmin: actorSuperAdmin });
  const actor = new Admin({ id: "host", socket: actorSocket.socket });
  room.setUserIdentity(actor.id, "host@example.com", "Host");
  room.addClient(actor);
  const targetSocket = makeSocket(targetClaims);
  const Target = targetAdmin ? Admin : Client;
  const target = new Target({ id: "target", socket: targetSocket.socket });
  const closeTransport = vi.fn();
  target.producerTransport = { close: closeTransport } as unknown as WebRtcTransport;
  room.setUserIdentity(target.id, "admin@example.com", "Target");
  room.addClient(target);
  const context = createConnectionContext(io, actorSocket.socket, state);
  context.currentRoom = room;
  context.currentClient = actor;
  registerAdminHandlers(context, { roomId: room.id });
  const invoke = (event: string, data: unknown) => {
    const handler = actorSocket.handlers.get(event);
    if (!handler) throw new Error(`Missing handler: ${event}`);
    const ack = vi.fn();
    void handler(...[data, ack] as never[]);
    return ack;
  };
  return { state, room, io, target, targetSocket, closeTransport, invoke };
};

describe("super admin socket moderation", () => {
  it.each([{ isSuperAdmin: true }, { isForcedHost: true }])(
    "prevents an ordinary host from kicking verified super admins (%j)",
    (targetClaims) => {
      const h = makeHarness({ targetClaims });
      expect(h.invoke("kickUser", { userId: "target" })).toHaveBeenCalledWith({
        error: SUPER_ADMIN_REMOVAL_ERROR,
      });
      expect(h.targetSocket.emit).not.toHaveBeenCalled();
      expect(h.targetSocket.disconnect).not.toHaveBeenCalled();
      expect(h.closeTransport).not.toHaveBeenCalled();
      expect(h.room.getClient("target")).toBe(h.target);
    },
  );

  it("protects one super admin from another super admin", () => {
    const h = makeHarness({ actorSuperAdmin: true });
    expect(h.invoke("kickUser", { userId: "target" })).toHaveBeenCalledWith({
      error: SUPER_ADMIN_REMOVAL_ERROR,
    });
  });

  it.each([true, false])("lets super admins kick other users (admin=%s)", (targetAdmin) => {
    const h = makeHarness({ actorSuperAdmin: true, targetAdmin, targetClaims: {} });
    expect(h.invoke("kickUser", { userId: "target" })).toHaveBeenCalledWith({ success: true });
    expect(h.targetSocket.emit).toHaveBeenCalledWith("kicked", {
      reason: "Removed by host", roomId: "room",
    });
    expect(h.targetSocket.disconnect).toHaveBeenCalledWith(true);
    expect(h.closeTransport).toHaveBeenCalledOnce();
    expect(h.room.getClient("target")).toBeUndefined();
  });

  it("does not protect users merely because their token says host/admin", () => {
    const h = makeHarness({ targetClaims: { isHost: true, isAdmin: true } });
    expect(h.invoke("kickUser", { userId: "target" })).toHaveBeenCalledWith({ success: true });
  });

  it.each([true, false])("rejects entire blocks containing a super admin (kickPresent=%s)", (kickPresent) => {
    const h = makeHarness();
    expect(h.invoke("admin:blockUsers", {
      userKeys: ["other@example.com", "admin@example.com"], kickPresent,
    })).toHaveBeenCalledWith({ error: SUPER_ADMIN_REMOVAL_ERROR });
    expect(h.room.isBlocked("other@example.com")).toBe(false);
    expect(h.room.isBlocked("admin@example.com")).toBe(false);
    expect(h.targetSocket.disconnect).not.toHaveBeenCalled();
  });

  it("protects clients at the shared kick primitive", () => {
    const h = makeHarness();
    expect(kickClient(h.room, "target")).toBe(false);
    expect(h.targetSocket.disconnect).not.toHaveBeenCalled();
  });

  it("still blocks and immediately removes an ordinary host", () => {
    const h = makeHarness({ actorSuperAdmin: true, targetClaims: {} });
    expect(h.invoke("admin:blockUsers", {
      userKeys: ["admin@example.com"],
    })).toHaveBeenCalledWith(expect.objectContaining({
      success: true, kickedUserIds: ["target"],
    }));
    expect(h.room.isBlocked("admin@example.com")).toBe(true);
    expect(h.room.getClient("target")).toBeUndefined();
    expect(h.closeTransport).toHaveBeenCalledOnce();
  });
});

describe("super admin join roles and blocked rejoin", () => {
  const setup = () => {
    const h = makeHarness();
    h.room.removeClient("target");
    const webinar = getOrCreateWebinarRoomConfig(h.state.webinarConfigs, h.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    setCustomWebinarLinkSlug({ webinarConfig: webinar, webinarLinks: h.state.webinarLinks, room: h.room, slug: "review-webinar" });
    const join = async (joinMode: "meeting" | "webinar_attendee", isSuperAdmin: boolean) => {
      const peer = makeSocket({
        userId: "admin@example.com", email: "admin@example.com", clientId: "conclave",
        sessionId: "admin-session", joinMode, isSuperAdmin,
      });
      const context = createConnectionContext(h.io, peer.socket, h.state);
      registerJoinRoomHandler(context);
      const ack = vi.fn();
      await peer.handlers.get("joinRoom")!(...[
        { roomId: joinMode === "meeting" ? h.room.id : "review-webinar", sessionId: "admin-session" }, ack,
      ] as never[]);
      return { context, peer, ack };
    };
    return { ...h, join };
  };

  it("grants host rights from an isSuperAdmin-only meeting token", async () => {
    const h = setup();
    const { context, peer, ack } = await h.join("meeting", true);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    expect(context.currentClient).toBeInstanceOf(Admin);
    const kick = vi.fn();
    await peer.handlers.get("kickUser")!(...[{ userId: "host" }, kick] as never[]);
    expect(kick).toHaveBeenCalledWith({ success: true });
  });

  it("keeps super admins in the attendee role without host handlers", async () => {
    const h = setup();
    const { context, peer, ack } = await h.join("webinar_attendee", true);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    expect(context.currentClient).not.toBeInstanceOf(Admin);
    expect(context.currentClient?.isWebinarAttendee).toBe(true);
    expect(peer.handlers.has("kickUser")).toBe(false);
    expect(h.room.getAdminUserIds()).toEqual(["host"]);
  });

  it.each([true, false])("honors verified protection after leave, block, and attendee rejoin (super=%s)", async (isSuperAdmin) => {
    const h = setup();
    const initial = await h.join("webinar_attendee", isSuperAdmin);
    expect(initial.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    h.room.removeClient(initial.context.currentClient!.id);
    expect(h.invoke("admin:blockUsers", { userKeys: ["admin@example.com"] }))
      .toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const rejoin = await h.join("webinar_attendee", isSuperAdmin);
    if (isSuperAdmin) {
      expect(rejoin.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
      expect(rejoin.context.currentClient?.isWebinarAttendee).toBe(true);
      expect(rejoin.context.currentClient).not.toBeInstanceOf(Admin);
    } else {
      expect(rejoin.ack).toHaveBeenCalledWith({ error: "You are not allowed to join this meeting." });
      expect(rejoin.context.currentClient).toBeNull();
    }
  });
});

const startApp = async (h: ReturnType<typeof makeHarness>) => {
  const server = createServer(createSfuApp({ state: h.state, config, getIo: () => h.io }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return (path: string, body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/admin/rooms/room/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sfu-secret": config.sfuSecret },
    body: JSON.stringify(body),
  });
};

describe("super admin HTTP moderation", () => {
  it.each(["users/target/kick", "users/target/block", "access/block"])(
    "rejects %s without removing or blocking the super admin",
    async (path) => {
      const h = makeHarness();
      const post = await startApp(h);
      const response = await post(path, { userKeys: ["other@example.com", "admin@example.com"] });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: SUPER_ADMIN_REMOVAL_ERROR });
      expect(h.room.isBlocked("admin@example.com")).toBe(false);
      expect(h.room.isBlocked("other@example.com")).toBe(false);
      expect(h.targetSocket.disconnect).not.toHaveBeenCalled();
    },
  );

  it("does not remove protected non-hosts during a bulk reset", async () => {
    const h = makeHarness({ targetAdmin: false });
    const post = await startApp(h);
    const response = await post("users/remove-non-admins", { includeAttendees: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kickedCount: 0, kickedUserIds: [] });
    expect(h.targetSocket.disconnect).not.toHaveBeenCalled();
  });

  it("still allows removing ordinary promoted hosts", async () => {
    const h = makeHarness({ targetClaims: {} });
    const post = await startApp(h);
    expect((await post("users/target/kick")).status).toBe(200);
    expect(h.room.getClient("target")).toBeUndefined();
    expect(h.closeTransport).toHaveBeenCalledOnce();
  });

  it.each(["users/target/block", "access/block"])("still allows %s for ordinary hosts", async (path) => {
    const h = makeHarness({ targetClaims: {} });
    const post = await startApp(h);
    expect((await post(path, { userKeys: ["admin@example.com"] })).status).toBe(200);
    expect(h.room.isBlocked("admin@example.com")).toBe(true);
    expect(h.room.getClient("target")).toBeUndefined();
    expect(h.closeTransport).toHaveBeenCalledOnce();
  });
});
