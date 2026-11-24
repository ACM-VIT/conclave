import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Router } from "mediasoup/types";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { getSocketContext } from "../server/socket/context.js";
import { registerAdminHandlers } from "../server/socket/handlers/adminHandlers.js";
import { registerConnectionHandlers } from "../server/socket/registerConnectionHandlers.js";
import { createSfuState } from "../server/state.js";

type Frame = { event: string; json: string };
type Peer = {
  client: ClientSocket;
  server: ServerSocket;
  frames: Frame[];
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = async (server: HttpServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
};

const makeStack = async () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "lobby-host-only",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const socketHttp = createServer();
  const io = new Server(socketHttp);
  io.use((socket, next) => {
    (socket.data as { user?: SfuAuthPayload }).user = (socket.handshake.auth as { user: SfuAuthPayload }).user;
    next();
  });
  registerConnectionHandlers(io, state);
  const socketPort = await listen(socketHttp);
  const adminHttp = createServer(createSfuApp({ state, config, getIo: () => io }));
  const adminPort = await listen(adminHttp);
  cleanups.push(async () => {
    await io.close();
    await new Promise<void>((resolve) => adminHttp.close(() => resolve()));
  });

  const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router: { close: () => undefined } as unknown as Router });
  state.rooms.set(room.channelId, room);

  const open = async (user: SfuAuthPayload): Promise<Peer> => {
    const client = connect(`http://127.0.0.1:${socketPort}`, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
      auth: { user },
    });
    const frames: Frame[] = [];
    client.onAny((event: string, ...args: unknown[]) => {
      frames.push({ event, json: JSON.stringify(args) });
    });
    client.on("barrier", (ack: () => void) => ack());
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    const server = io.sockets.sockets.get(client.id!);
    if (!server) throw new Error("Missing server socket");
    cleanups.push(async () => {
      client.close();
    });
    return { client, server, frames };
  };

  const seat = async (id: string, email: string, asHost: boolean): Promise<Peer> => {
    const peer = await open({ userId: email, email, clientId: "conclave", sessionId: id });
    const member = asHost
      ? new Admin({ id, socket: peer.server })
      : new Client({ id, socket: peer.server });
    room.setUserIdentity(id, email, id);
    room.addClient(member);
    await peer.server.join(room.channelId);
    const context = getSocketContext(peer.server)!;
    context.currentRoom = room;
    context.currentClient = member;
    context.currentUserKey = email;
    if (asHost) registerAdminHandlers(context, { roomId: room.id });
    return peer;
  };

  const knock = async (email: string): Promise<Peer> => {
    const peer = await open({ userId: email, email, clientId: "conclave", sessionId: `${email}-session` });
    const ack: unknown = await peer.client.timeout(2000).emitWithAck("joinRoom", {
      roomId: room.id,
      sessionId: `${email}-session`,
    });
    expect(ack).toEqual(expect.objectContaining({ status: "waiting" }));
    return peer;
  };

  const adminPost = (path: string, body: unknown = {}) =>
    fetch(`http://127.0.0.1:${adminPort}/admin/rooms/room/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sfu-secret": config.sfuSecret },
      body: JSON.stringify(body),
    });

  return { io, room, seat, knock, adminPost };
};

const ask = (peer: Peer, event: string, ...args: unknown[]) =>
  peer.client.timeout(2000).emitWithAck(event, ...args);

const settle = (peers: Peer[]) =>
  Promise.all(peers.map((peer) => peer.server.timeout(2000).emitWithAck("barrier")));

const leaks = (peer: Peer, secrets: string[]) =>
  peer.frames.filter((frame) => secrets.some((secret) => frame.json.includes(secret)));

const pendingSnapshots = (peer: Peer) =>
  peer.frames.filter((frame) => frame.event === "pendingUsersSnapshot");

const firstArg = <T>(frame: Frame): T => (JSON.parse(frame.json) as T[])[0];

const listedKeys = (frame: Frame): string[] =>
  firstArg<{ users: Array<{ userId: string }> }>(frame).users.map((user) => user.userId).sort();

describe("waiting-room privacy", () => {
  it("updates hosts on every lobby transition and never shows a participant who is waiting", async () => {
    const stack = await makeStack();
    const host = await stack.seat("host", "host@example.com", true);
    const participant = await stack.seat("participant", "participant@example.com", false);
    const bystander = await stack.seat("bystander", "bystander@example.com", false);
    const watchers = [host, participant, bystander];
    const secrets: string[] = [];
    const waiting = new Set<string>();

    const framesFrom = async (peer: Peer, action: () => Promise<unknown>): Promise<Frame[]> => {
      await settle(watchers);
      const mark = peer.frames.length;
      await action();
      await settle(watchers);
      return peer.frames.slice(mark);
    };
    const expectSnapshot = (frames: Frame[]) => {
      const snapshots = frames.filter((frame) => frame.event === "pendingUsersSnapshot");
      expect(snapshots.length).toBeGreaterThan(0);
      expect(listedKeys(snapshots.at(-1)!)).toEqual([...waiting].sort());
    };
    const expectNotice = (frames: Frame[], event: string, userKey: string) => {
      expect(
        frames.filter((frame) => frame.event === event).map((frame) => firstArg<{ userId: string }>(frame).userId),
      ).toContain(userKey);
    };
    const lobbyGuest = async (email: string) => {
      let peer: Peer | undefined;
      const frames = await framesFrom(host, async () => {
        peer = await stack.knock(email);
      });
      secrets.push(email, peer!.client.id!);
      waiting.add(email);
      expectNotice(frames, "userRequestedJoin", email);
      return peer!;
    };
    const decide = async (userKeys: string[], action: () => Promise<unknown>) => {
      for (const userKey of userKeys) waiting.delete(userKey);
      return framesFrom(host, action);
    };
    const httpOk = (path: string, body?: unknown) => async () => {
      expect((await stack.adminPost(path, body)).status).toBe(200);
    };

    expect(await ask(host, "lockRoom", { locked: true })).toEqual(expect.objectContaining({ success: true }));
    const stillWaiting = await lobbyGuest("still-waiting@example.com");

    const admittedOne = await lobbyGuest("admit-one@example.com");
    expectNotice(await decide(["admit-one@example.com"], async () => {
      expect(await ask(host, "admitUser", { userId: "admit-one@example.com" })).toEqual({ success: true });
    }), "userAdmitted", "admit-one@example.com");
    expect(admittedOne.frames.some((frame) => frame.event === "joinApproved")).toBe(true);

    await lobbyGuest("allow@example.com");
    expectSnapshot(await decide(["allow@example.com"], async () => {
      expect(await ask(host, "admin:allowUsers", { userKeys: ["allow@example.com"] }))
        .toEqual(expect.objectContaining({ success: true, admitted: ["allow@example.com"] }));
    }));

    await lobbyGuest("reject@example.com");
    expectNotice(await decide(["reject@example.com"], async () => {
      expect(await ask(host, "rejectUser", { userId: "reject@example.com" })).toEqual({ success: true });
    }), "userRejected", "reject@example.com");

    await lobbyGuest("block@example.com");
    expectSnapshot(await decide(["block@example.com"], async () => {
      expect(await ask(host, "admin:blockUsers", { userKeys: ["block@example.com"] }))
        .toEqual(expect.objectContaining({ rejectedPending: ["block@example.com"] }));
    }));

    const leaver = await lobbyGuest("leaver@example.com");
    expectNotice(await decide(["leaver@example.com"], async () => {
      leaver.client.close();
      await expect.poll(() => stack.room.pendingClients.has("leaver@example.com")).toBe(false);
    }), "pendingUserLeft", "leaver@example.com");

    await lobbyGuest("http-admit@example.com");
    expectSnapshot(await decide(["http-admit@example.com"], httpOk("pending/http-admit%40example.com/admit")));
    await lobbyGuest("http-reject@example.com");
    expectSnapshot(await decide(["http-reject@example.com"], httpOk("pending/http-reject%40example.com/reject")));
    await lobbyGuest("http-allow@example.com");
    expectSnapshot(await decide(["http-allow@example.com"], httpOk("access/allow", { userKeys: ["http-allow@example.com"] })));
    await lobbyGuest("http-block@example.com");
    expectSnapshot(await decide(["http-block@example.com"], httpOk("access/block", { userKeys: ["http-block@example.com"] })));

    expect(await ask(host, "lockRoom", { locked: false })).toEqual(expect.objectContaining({ success: true }));
    expect(await ask(host, "lockRoom", { locked: true })).toEqual(expect.objectContaining({ success: true }));
    expect(stack.room.pendingClients.has("still-waiting@example.com")).toBe(true);

    await settle(watchers);
    const participantFramesWhileNotHost = participant.frames.length;
    expectSnapshot(await framesFrom(participant, async () => {
      expect(await ask(host, "promoteHost", { userId: "participant" })).toEqual(expect.objectContaining({ success: true }));
    }));

    let promotedFrames: Frame[] = [];
    const hostFrames = await decide(["still-waiting@example.com"], async () => {
      promotedFrames = await framesFrom(participant, async () => {
        expect(await ask(host, "admin:admitAllPending")).toEqual(expect.objectContaining({ admittedCount: 1 }));
      });
    });
    expectSnapshot(hostFrames);
    expectSnapshot(promotedFrames);
    expect(stillWaiting.frames.some((frame) => frame.event === "joinApproved")).toBe(true);

    await lobbyGuest("reject-all@example.com");
    expectSnapshot(await decide(["reject-all@example.com"], async () => {
      expect(await ask(host, "admin:rejectAllPending")).toEqual(expect.objectContaining({ rejectedCount: 1 }));
    }));
    await lobbyGuest("http-admit-all@example.com");
    expectSnapshot(await decide(["http-admit-all@example.com"], httpOk("pending/admit-all")));
    await lobbyGuest("http-reject-all@example.com");
    expectSnapshot(await decide(["http-reject-all@example.com"], httpOk("pending/reject-all")));

    expect(leaks(bystander, secrets).map((frame) => frame.event)).toEqual([]);
    expect(pendingSnapshots(bystander)).toEqual([]);
    const participantBeforePromotion = { ...participant, frames: participant.frames.slice(0, participantFramesWhileNotHost) };
    expect(leaks(participantBeforePromotion, secrets).map((frame) => frame.event)).toEqual([]);
    expect(pendingSnapshots(participantBeforePromotion)).toEqual([]);
  });
});
