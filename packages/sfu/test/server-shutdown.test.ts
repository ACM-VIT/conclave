import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import {
  createMemoryRoomRecoveryStore,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import {
  createConnectionContext,
  setSocketContext,
  type ConnectionContext,
} from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";

type Handler = (...args: unknown[]) => unknown;
type JoinAck = { status?: string; error?: string; roomRecoveryPass?: string };
type Sfu = { state: SfuState; io: SocketIOServer; channels: Map<string, Set<Peer>> };
type Peer = {
  socket: Socket;
  wire: { connected: boolean };
  handlers: Map<string, Handler>;
  context: ConnectionContext;
};

const CODE = "abc-mnop-xyz";
const CHANNEL = `conclave:${CODE}`;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const closePeer = (sfu: Sfu, peer: Peer, reason: string): void => {
  if (!peer.wire.connected) return;
  peer.wire.connected = false;
  for (const members of sfu.channels.values()) members.delete(peer);
  void peer.handlers.get("disconnect")?.(reason);
};

const makeSfu = (recovery: RoomRecoveryStore, name: string): Sfu => {
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: () => undefined,
  } as unknown as Router;
  const worker = {
    pid: 1,
    closed: false,
    createRouter: async () => router,
  } as unknown as Worker;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: name,
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
    roomRecoveryStore: recovery,
  });
  state.workers = [worker];
  const sfu: Sfu = { state, channels: new Map(), io: undefined as unknown as SocketIOServer };
  sfu.io = {
    to: () => ({ emit: () => true }),
    in: (channel: string) => ({
      disconnectSockets: () => {
        for (const peer of [...(sfu.channels.get(channel) ?? [])]) {
          closePeer(sfu, peer, "server namespace disconnect");
        }
      },
    }),
  } as unknown as SocketIOServer;
  return sfu;
};

let tabs = 0;
const connect = (sfu: Sfu, user: SfuAuthPayload): Peer => {
  tabs += 1;
  const handlers = new Map<string, Handler>();
  const wire = { connected: true };
  const peer = { handlers, wire } as Peer;
  const socket = {
    id: `tab-${tabs}`,
    data: { user },
    get connected() {
      return wire.connected;
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    emit: () => true,
    disconnect: () => closePeer(sfu, peer, "server namespace disconnect"),
    join: (channel: string) => {
      const members = sfu.channels.get(channel) ?? new Set<Peer>();
      members.add(peer);
      sfu.channels.set(channel, members);
    },
    leave: (channel: string) => {
      sfu.channels.get(channel)?.delete(peer);
    },
    to: () => ({ emit: () => true }),
  };
  peer.socket = socket as unknown as Socket;
  peer.context = createConnectionContext(sfu.io, peer.socket, sfu.state);
  setSocketContext(peer.socket, peer.context);
  registerJoinRoomHandler(peer.context);
  registerDisconnectHandlers(peer.context);
  return peer;
};

const ask = async (peer: Peer, user: SfuAuthPayload, pass?: string): Promise<JoinAck> => {
  let answer: JoinAck = {};
  await peer.handlers.get("joinRoom")?.(
    { roomId: CODE, sessionId: user.sessionId, roomRecoveryPass: pass },
    (response: JoinAck) => {
      answer = response;
    },
  );
  return answer;
};

const send = async (peer: Peer, event: string, payload: unknown) => {
  let answer: { success?: boolean } | undefined;
  await peer.handlers.get(event)?.(payload, (response: { success?: boolean }) => {
    answer = response;
  });
  return answer;
};

const serve = async (sfu: Sfu): Promise<string> => {
  const server = createServer(createSfuApp({ state: sfu.state, config, getIo: () => sfu.io }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The SFU app did not bind a port");
  return `http://127.0.0.1:${address.port}`;
};

const host = {
  userId: "guest-host",
  clientId: "conclave",
  sessionId: "h",
  allowRoomCreation: true,
} satisfies SfuAuthPayload;
const member = { userId: "guest-member", clientId: "conclave", sessionId: "m" } satisfies SfuAuthPayload;
const removed = { userId: "guest-removed", clientId: "conclave", sessionId: "r" } satisfies SfuAuthPayload;
const knocker = {
  userId: "guest-knocker",
  clientId: "conclave",
  sessionId: "k",
  allowRoomCreation: true,
} satisfies SfuAuthPayload;

describe("a forced drain through POST /drain", () => {
  it("leaves the call to come back on another SFU with its hosts, removals and passes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recovery = createMemoryRoomRecoveryStore();
    const a = makeSfu(recovery, "sfu-a");
    const hostTab = connect(a, host);
    expect((await ask(hostTab, host)).status).toBe("joined");
    const memberTab = connect(a, member);
    expect((await ask(memberTab, member)).status).toBe("waiting");
    expect(await send(hostTab, "admitUser", { userId: member.userId })).toEqual({ success: true });
    const memberJoin = await ask(memberTab, member);
    expect(memberJoin.status).toBe("joined");
    const removedTab = connect(a, removed);
    await ask(removedTab, removed);
    await send(hostTab, "admitUser", { userId: removed.userId });
    expect((await ask(removedTab, removed)).status).toBe("joined");
    expect(await send(hostTab, "kickUser", { userId: `${removed.userId}#${removed.sessionId}` })).toEqual({
      success: true,
    });

    const drained = await fetch(`${await serve(a)}/drain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sfu-secret": config.sfuSecret },
      body: JSON.stringify({ draining: true, force: true, noticeMs: 0 }),
    });
    expect(drained.status).toBe(200);
    expect(a.state.rooms.size).toBe(0);

    const b = makeSfu(recovery, "sfu-b");
    const recalled = await b.state.roomRecovery.recall(CHANNEL);
    expect(recalled.lost?.adminUserKeys).toEqual([host.userId]);
    expect(recalled.lost?.readmissionRequiredUserKeys).toEqual([removed.userId]);
    expect(recalled.passesVoidUntil).toBeNull();

    const knockerTab = connect(b, knocker);
    expect((await ask(knockerTab, knocker)).status).toBe("waiting");
    const memberBack = connect(b, member);
    expect((await ask(memberBack, member, memberJoin.roomRecoveryPass)).status).toBe("joined");
    expect(memberBack.context.currentClient).toBeInstanceOf(Admin);
    expect(knockerTab.context.currentClient).toBeNull();
    const removedBack = connect(b, removed);
    expect((await ask(removedBack, removed)).status).toBe("waiting");
  });
});

describe("an operator blocking a meeting's only host through the HTTP route", () => {
  it("hands the host's seat to someone still in the meeting", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sfu = makeSfu(createMemoryRoomRecoveryStore(), "sfu-a");
    const hostTab = connect(sfu, host);
    expect((await ask(hostTab, host)).status).toBe("joined");
    const memberTab = connect(sfu, member);
    await ask(memberTab, member);
    await send(hostTab, "admitUser", { userId: member.userId });
    expect((await ask(memberTab, member)).status).toBe("joined");

    const blocked = await fetch(
      `${await serve(sfu)}/admin/rooms/${CODE}/users/${encodeURIComponent(`${host.userId}#${host.sessionId}`)}/block`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sfu-secret": config.sfuSecret,
          "x-sfu-client": "conclave",
        },
        body: JSON.stringify({ reason: "Blocked by operator" }),
      },
    );
    expect(blocked.status).toBe(200);
    const room = sfu.state.rooms.get(CHANNEL);
    expect(room?.isBlocked(host.userId)).toBe(true);
    expect(memberTab.context.currentClient).toBeInstanceOf(Admin);
  });
});

describe("an operator resetting a meeting through the HTTP route", () => {
  it("keeps everyone who hosts it, through every tab they have open", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sfu = makeSfu(createMemoryRoomRecoveryStore(), "sfu-a");
    const hostTab = connect(sfu, host);
    expect((await ask(hostTab, host)).status).toBe("joined");
    const memberTab = connect(sfu, member);
    await ask(memberTab, member);
    await send(hostTab, "admitUser", { userId: member.userId });
    expect((await ask(memberTab, member)).status).toBe("joined");
    const memberAgain = { ...member, sessionId: "m2" } satisfies SfuAuthPayload;
    const secondTab = connect(sfu, memberAgain);
    expect((await ask(secondTab, memberAgain)).status).toBe("joined");
    const otherTab = connect(sfu, removed);
    await ask(otherTab, removed);
    await send(hostTab, "admitUser", { userId: removed.userId });
    expect((await ask(otherTab, removed)).status).toBe("joined");
    expect(
      await send(hostTab, "promoteHost", { userId: `${member.userId}#${member.sessionId}` }),
    ).toMatchObject({ success: true });

    const reset = await fetch(`${await serve(sfu)}/admin/rooms/${CODE}/users/remove-non-admins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sfu-secret": config.sfuSecret,
        "x-sfu-client": "conclave",
      },
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const { kickedUserIds } = (await reset.json()) as { kickedUserIds: string[] };
    expect(kickedUserIds).toEqual([`${removed.userId}#${removed.sessionId}`]);
    const room = sfu.state.rooms.get(CHANNEL);
    expect(room?.getClient(`${member.userId}#${member.sessionId}`)).toBeInstanceOf(Admin);
    expect(room?.getClient(`${member.userId}#${memberAgain.sessionId}`)).toBeInstanceOf(Admin);
    expect(room?.getClient(`${removed.userId}#${removed.sessionId}`)).toBeUndefined();
  });
});
