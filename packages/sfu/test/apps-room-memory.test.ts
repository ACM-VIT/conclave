import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import {
  MAX_CLIENT_IDS_PER_PARTICIPANT,
  MAX_NEW_CLIENT_IDS_PER_UPDATE,
  MAX_PRESENCE_IDS_PER_PARTICIPANT,
  MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION,
  RoomApps,
  type StageCommandResult,
} from "../server/roomApps.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { createSfuState } from "../server/state.js";
import { authoredBy, awarenessPacket, presencePacket, seededRandom } from "./support/appsRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("presence holds an id only while the room shows its cursor", () => {
  const boardWithPresence = () => {
    const apps = new RoomApps((userId) => userId.split("#")[0]);
    apps.present("board");
    return apps;
  };

  const shownIds = (apps: RoomApps): number[] => {
    const snapshot = apps.encodeAwarenessSnapshot("board");
    if (!snapshot) return [];
    const decoder = decoding.createDecoder(snapshot);
    const ids: number[] = [];
    for (let left = decoding.readVarUint(decoder); left > 0; left -= 1) {
      ids.push(decoding.readVarUint(decoder));
      decoding.readVarUint(decoder);
      decoding.readVarString(decoder);
    }
    return ids.sort((a, b) => a - b);
  };

  it("holds nothing for a cursor the room ignores", () => {
    const apps = boardWithPresence();

    const ignored = apps.applyAwarenessUpdate("board", presencePacket([7], 0), "viewer#1");

    expect(apps.heldPresenceIds).toEqual(new Map());
    expect(ignored).toBeNull();
    expect(apps.applyAwarenessUpdate("board", presencePacket([7]), "peer#1")).not.toBeNull();
    expect(apps.applyAwarenessUpdate("board", presencePacket([11, 12, 13, 14]), "viewer#1")).not.toBeNull();
    expect(shownIds(apps)).toEqual([7, 11, 12, 13, 14]);
  });

  it("ignores a late cursor for an id its owner removed, and holds nothing for it", () => {
    const apps = boardWithPresence();
    apps.applyAwarenessUpdate("board", presencePacket([20], 3), "viewer#1");
    apps.applyAwarenessUpdate("board", presencePacket([20], 4, "null"), "viewer#1");

    const late = apps.applyAwarenessUpdate("board", presencePacket([20], 3), "viewer#1");

    expect(apps.heldPresenceIds).toEqual(new Map());
    expect(late).toBeNull();
    expect(shownIds(apps)).toEqual([]);
  });

  it("frees an id whose cursor the same packet shows and then removes", () => {
    const apps = boardWithPresence();

    apps.applyAwarenessUpdate(
      "board",
      awarenessPacket([
        { client: 30, clock: 1, state: "{}" },
        { client: 30, clock: 2, state: "null" },
      ]),
      "viewer#1",
    );

    expect(apps.heldPresenceIds).toEqual(new Map());
    expect(shownIds(apps)).toEqual([]);
  });

  it("keeps what it remembers of removed cursors bounded through a long session", () => {
    const apps = boardWithPresence();
    for (let index = 0; index < 2000; index += 1) {
      const client = 50_000 + index;
      apps.applyAwarenessUpdate("board", presencePacket([client]), "viewer#1");
      apps.applyAwarenessUpdate("board", presencePacket([client], 2, "null"), "viewer#1");
    }
    for (let guest = 0; guest < 300; guest += 1) {
      const clients = Array.from(
        { length: MAX_PRESENCE_IDS_PER_PARTICIPANT },
        (_, index) => 100_000 + guest * 10 + index,
      );
      apps.applyAwarenessUpdate("board", presencePacket(clients), `guest${guest}#1`);
      apps.clearUserAwareness(`guest${guest}#1`);
    }

    expect(apps.presenceRecordCount("board")).toBeLessThanOrEqual(
      MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION,
    );
    expect(apps.applyAwarenessUpdate("board", presencePacket([51_999], 1), "viewer#1")).toBeNull();
    expect(apps.heldPresenceIds).toEqual(new Map());
  });

  it("holds exactly the ids of the cursors it shows, across random presence, writes and stage changes", () => {
    const apps = boardWithPresence();
    const random = seededRandom(274);
    const participants = ["p0", "p1", "p2", "p3"];
    const connections = participants.map((participant) => `${participant}#0`);
    const writers = new Map<number, string>();
    const pool = [...Array.from({ length: 10 }, (_, index) => index + 1), 900, 901, 902, 903];
    let fresh = 10_000;
    const writeUnder = (clients: number[], connection: string) => {
      if (!apps.liveDoc("board")) return;
      const update = Y.mergeUpdates(
        clients.map((client) => {
          const writer = new Y.Doc();
          Y.applyUpdate(writer, Y.encodeStateAsUpdate(apps.liveDoc("board")!));
          writer.clientID = client;
          const before = Y.encodeStateVector(writer);
          writer.getMap("m").set(`w${client}:${fresh++}`, 1);
          return Y.encodeStateAsUpdate(writer, before);
        }),
      );
      if (apps.write("board", connection, update, apps.syncMark("board")) === null) {
        for (const client of clients) writers.set(client, connection.split("#")[0]);
      }
    };

    for (let round = 0; round < 3000; round += 1) {
      const slot = Math.floor(random() * connections.length);
      const roll = random();
      if (roll < 0.04) {
        apps.clearUserAwareness(connections[slot]);
        connections[slot] = `${participants[slot]}#${round + 1}`;
      } else if (roll < 0.05) {
        apps.close();
        apps.present("board");
      } else if (roll < 0.06) {
        apps.present("other");
        apps.present("board");
      } else if (roll < 0.065) {
        apps.discard("board");
        writers.clear();
        apps.present("board");
      } else if (roll < 0.1) {
        const count = 1 + Math.floor(random() * 3);
        const clients = Array.from({ length: count }, () =>
          random() < 0.5 ? fresh++ : pool[Math.floor(random() * pool.length)],
        );
        writeUnder([...new Set(clients)], connections[slot]);
      } else {
        const entries = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
          client: random() < 0.2 ? fresh++ : pool[Math.floor(random() * pool.length)],
          clock: Math.floor(random() * (8 + round / 10)),
          state: random() < 0.3 ? "null" : JSON.stringify({ x: Math.floor(random() * 3) }),
        }));
        apps.applyAwarenessUpdate("board", awarenessPacket(entries), connections[slot]);
      }

      const shown = shownIds(apps);
      const held = apps.heldPresenceIds;
      expect([...held.keys()].sort((a, b) => a - b)).toEqual(
        shown.filter((client) => !writers.has(client)),
      );
      const shownBy = new Map<string, number>();
      for (const client of shown) {
        const owner = writers.get(client) ?? held.get(client);
        expect(owner, `cursor ${client} has an owner`).toBeDefined();
        shownBy.set(owner!, (shownBy.get(owner!) ?? 0) + 1);
      }
      for (const count of shownBy.values()) {
        expect(count).toBeLessThanOrEqual(MAX_PRESENCE_IDS_PER_PARTICIPANT);
      }
      expect(apps.presenceRecordCount("board")).toBeLessThanOrEqual(
        shown.length + MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION * connections.length,
      );
      expect(apps.boundClientIdCount).toBeLessThanOrEqual(apps.documentWriterCount);
    }
  }, 60_000);
});


const removedIds = (update: Uint8Array): number[] => {
  const decoder = decoding.createDecoder(update);
  const ids: number[] = [];
  for (let left = decoding.readVarUint(decoder); left > 0; left -= 1) {
    const client = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    expect(decoding.readVarString(decoder)).toBe("null");
    ids.push(client);
  }
  return ids.sort((a, b) => a - b);
};

const removalOf = (result: StageCommandResult): Uint8Array | undefined =>
  result.ok ? result.awarenessRemoval?.awarenessUpdate : undefined;

const SEVENTEEN = Array.from({ length: 17 }, (_, index) => 700 + index);

const writeUnderEach = (apps: RoomApps, appId: string, userId: string, clients: number[]) => {
  for (let start = 0; start < clients.length; start += MAX_NEW_CLIENT_IDS_PER_UPDATE) {
    const batch = clients.slice(start, start + MAX_NEW_CLIENT_IDS_PER_UPDATE);
    expect(apps.write(appId, userId, authoredBy(batch), apps.syncMark(appId))).toBeNull();
  }
};

const showEach = (apps: RoomApps, appId: string, userId: string, clients: number[]): number[] =>
  clients.filter((client) => apps.applyAwarenessUpdate(appId, presencePacket([client]), userId) !== null);

describe("a participant's cursors", () => {
  it("are at most four, whatever ids they write under", () => {
    const apps = new RoomApps((userId) => userId.split("#")[0]);
    apps.present("whiteboard");
    writeUnderEach(apps, "whiteboard", "writer#1", SEVENTEEN);

    const shown = showEach(apps, "whiteboard", "writer#1", SEVENTEEN);

    expect(shown).toEqual(SEVENTEEN.slice(0, MAX_PRESENCE_IDS_PER_PARTICIPANT));
  });

  it.each([
    ["close", (apps: RoomApps) => removalOf(apps.close())],
    ["replace", (apps: RoomApps) => removalOf(apps.present("watch"))],
    ["clear", (apps: RoomApps) => removalOf(apps.discard("whiteboard"))],
    ["leave", (apps: RoomApps) => apps.clearUserAwareness("writer#1")[0]?.awarenessUpdate],
  ] as const)("are all removed by one packet when the host or the owner does %s", (_, act) => {
    const apps = new RoomApps((userId) => userId.split("#")[0]);
    apps.present("whiteboard");
    writeUnderEach(apps, "whiteboard", "writer#1", SEVENTEEN);
    const shown = showEach(apps, "whiteboard", "writer#1", SEVENTEEN);

    let removal: Uint8Array | undefined;
    expect(() => {
      removal = act(apps);
    }).not.toThrow();

    expect(removal && removedIds(removal)).toEqual(shown);
  });
});

describe("cursor cleanup when a seat's reconnect window ends", () => {
  const seatWithCursors = (state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "apps-memory", instanceUrl: "http://localhost", ttlMs: 45000 }),
  })) => {
    const room = new Room({
      id: "room",
      clientId: "conclave",
      workerPid: null,
      router: { closed: false, close: () => {} } as unknown as Router,
    });
    state.rooms.set(room.channelId, room);
    const broadcasts: { event: string; payload: unknown }[] = [];
    const io = {
      to: () => ({ emit: (event: string, payload: unknown) => broadcasts.push({ event, payload }) }),
    } as unknown as SocketIOServer;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const socket = {
      id: "writer-socket",
      data: { user: {} },
      connected: false,
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      emit: () => true,
      to: () => ({ emit: () => true }),
      join: () => {},
      leave: () => {},
      disconnect: () => {},
    } as unknown as Socket;
    const seat = new Client({ id: "writer#1", socket });
    room.addClient(seat);
    const context = createConnectionContext(io, socket, state);
    context.currentRoom = room;
    context.currentClient = seat;
    registerDisconnectHandlers(context);
    room.apps.present("whiteboard");
    writeUnderEach(room.apps, "whiteboard", "writer#1", SEVENTEEN);
    const shown = showEach(room.apps, "whiteboard", "writer#1", SEVENTEEN);
    return { room, broadcasts, handlers, shown };
  };

  it("removes the seat's cursors from a timer without throwing", () => {
    vi.useFakeTimers();
    const { room, broadcasts, handlers, shown } = seatWithCursors();

    handlers.get("disconnect")!("transport close");
    expect(() => vi.advanceTimersByTime(config.socket.disconnectGraceMs + 1)).not.toThrow();

    const removal = broadcasts.find((sent) => sent.event === "apps:awareness");
    expect(removedIds((removal!.payload as { awarenessUpdate: Uint8Array }).awarenessUpdate)).toEqual(shown);
    expect(room.apps.encodeAwarenessSnapshot("whiteboard")).toBeNull();
  });

  it("keeps the SFU process running when that timer fires", () => {
    const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const code = `
      import * as Y from "yjs";
      import * as encoding from "lib0/encoding";
      import { Room } from ${module("../config/classes/Room.ts")};
      import { Client } from ${module("../config/classes/Client.ts")};
      import { createSfuState } from ${module("../server/state.ts")};
      import { LocalRoomRegistry } from ${module("../server/roomRegistry.ts")};
      import { createConnectionContext } from ${module("../server/socket/context.ts")};
      import { registerDisconnectHandlers } from ${module("../server/socket/handlers/disconnectHandlers.ts")};
      const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "crash", instanceUrl: "http://localhost", ttlMs: 45000 }) });
      const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router: { closed: false, close: () => {} } });
      state.rooms.set(room.channelId, room);
      const io = { to: () => ({ emit: () => true }) };
      const handlers = new Map();
      const socket = { id: "s", data: { user: {} }, connected: false, on: (e, h) => handlers.set(e, h), emit: () => true, to: () => ({ emit: () => true }), join() {}, leave() {}, disconnect() {} };
      const seat = new Client({ id: "writer#1", socket });
      room.addClient(seat);
      const context = createConnectionContext(io, socket, state);
      context.currentRoom = room;
      context.currentClient = seat;
      registerDisconnectHandlers(context);
      room.apps.present("whiteboard");
      for (let client = 700; client < 717; client += 1) {
        const author = new Y.Doc();
        author.clientID = client;
        author.getMap("shapes").set("s" + client, true);
        room.apps.write("whiteboard", "writer#1", Y.encodeStateAsUpdate(author), room.apps.syncMark("whiteboard"));
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint(encoder, client);
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarString(encoder, "{}");
        room.apps.applyAwarenessUpdate("whiteboard", encoding.toUint8Array(encoder), "writer#1");
      }
      handlers.get("disconnect")("transport close");
      setTimeout(() => console.log("SFU_STILL_RUNNING"), 400);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, SFU_SOCKET_DISCONNECT_GRACE_MS: "50", SFU_LOG_LEVEL: "error" },
    });

    expect(result.stderr).not.toMatch(/TypeError|Uncaught/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SFU_STILL_RUNNING");
  }, 40_000);
});

describe("what a room keeps about writers over a meeting", () => {
  const stroke = (client: number, key: string): Uint8Array => {
    const author = new Y.Doc();
    author.clientID = client;
    author.getMap("shapes").set(key, true);
    return Y.encodeStateAsUpdate(author);
  };

  it("lets a host who clears the board again and again keep drawing on a fresh copy each time", () => {
    const apps = new RoomApps();
    apps.present("whiteboard");
    const refused: string[] = [];

    for (let round = 0; round < MAX_CLIENT_IDS_PER_PARTICIPANT + 100; round += 1) {
      const refusal = apps.write("whiteboard", "host", stroke(100_000 + round, "s"), apps.syncMark("whiteboard"));
      if (refusal) refused.push(`${round}:${refusal}`);
      apps.discard("whiteboard");
      apps.present("whiteboard");
    }

    expect(refused).toEqual([]);
    expect(apps.boundClientIdCount).toBe(0);
  });

  it("binds no writer of a cleared board and still refuses every one of them", () => {
    const apps = new RoomApps();
    apps.present("whiteboard");
    const stale: Uint8Array[] = [];
    for (let guest = 0; guest < 12; guest += 1) {
      const update = stroke(200 + guest, `session-${guest}`);
      expect(apps.write("whiteboard", `guest-${guest}`, update, apps.syncMark("whiteboard"))).toBeNull();
      stale.push(update);
      apps.discard("whiteboard");
      apps.present("whiteboard");
    }

    expect(apps.boundClientIdCount).toBe(0);
    for (const [guest, update] of stale.entries()) {
      expect(apps.write("whiteboard", `late-${guest}`, update, apps.syncMark("whiteboard"))).toBe("cleared");
    }
    expect(Y.encodeStateVector(apps.liveDoc("whiteboard")!)).toEqual(Y.encodeStateVector(new Y.Doc()));
  });

  it("never forgets a cleared writer, however many boards were cleared", () => {
    const apps = new RoomApps();
    apps.present("whiteboard");
    const cleared: number[] = [];
    for (let round = 0; round < 3000; round += 1) {
      const clients = [300_000 + round * 4, 300_001 + round * 4, 300_002 + round * 4];
      for (const client of clients) {
        expect(apps.write("whiteboard", `guest-${round}`, stroke(client, `k${client}`), apps.syncMark("whiteboard"))).toBeNull();
      }
      cleared.push(...clients);
      apps.discard("whiteboard");
      apps.present("whiteboard");
    }

    const forgotten = cleared.filter(
      (client) => apps.write("whiteboard", "late", stroke(client, "again"), apps.syncMark("whiteboard")) !== "cleared",
    );
    expect(forgotten).toEqual([]);
    const fresh = Array.from({ length: 5000 }, (_, index) => 900_000 + index * 7);
    const mistaken = fresh.filter(
      (client) => apps.write("whiteboard", `fresh-${client}`, stroke(client, "new"), apps.syncMark("whiteboard")) === "cleared",
    );
    expect(mistaken.length).toBeLessThanOrEqual(5);
  }, 60_000);
});
