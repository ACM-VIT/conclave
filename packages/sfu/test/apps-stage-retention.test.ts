import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAppsHandlers } from "../server/socket/handlers/appsHandlers.js";
import { createSfuState } from "../server/state.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  MAX_APP_DOC_BYTES,
  MAX_ROOM_APP_DOCS,
  RoomApps,
} from "../server/roomApps.js";
import type { AppsState } from "../types.js";

type Listener = (...args: unknown[]) => unknown;
type Sent = { event: string; payload: unknown };

const makeRoom = () => {
  const broadcasts: Sent[] = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
    }),
  } as unknown as SocketIOServer;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "apps-stage",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const router = { closed: false, close: () => {} } as unknown as Router;
  const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router });
  state.rooms.set(room.channelId, room);

  const join = (id: string, role: "host" | "participant") => {
    const listeners = new Map<string, Listener>();
    const relayed: Sent[] = [];
    const socket = {
      id: `socket-${id}`,
      data: { user: {} },
      on: (event: string, listener: Listener) => {
        listeners.set(event, listener);
        return socket;
      },
      to: () => ({
        emit: (event: string, payload: unknown) => relayed.push({ event, payload }),
      }),
      emit: vi.fn(),
    } as unknown as Socket;
    const client = role === "host" ? new Admin({ id, socket }) : new Client({ id, socket });
    room.addClient(client);
    const context = createConnectionContext(io, socket, state);
    context.currentRoom = room;
    context.currentClient = client;
    registerAppsHandlers(context);

    const ask = <T>(event: string, ...args: unknown[]): T => {
      let response: T | undefined;
      listeners.get(event)!(...args, (value: T) => {
        response = value;
      });
      return response as T;
    };
    const doc = new Y.Doc();
    return {
      relayed,
      doc,
      present: (appId: string, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:open", { appId, expectedRevision }),
      closeLegacy: () => ask<{ success: boolean; error?: string }>("apps:close"),
      close: (expectedRevision: number) =>
        ask<{ success: boolean; error?: string }>("apps:close", { expectedRevision }),
      discard: (appId: string, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:discard", { appId, expectedRevision }),
      lock: (locked: boolean, expectedRevision?: number) =>
        ask<{ success: boolean; error?: string }>("apps:lock", { locked, expectedRevision }),
      state: () => ask<AppsState>("apps:getState"),
      draw: (appId: string, key: string, value: unknown = true) => {
        const before = Y.encodeStateVector(doc);
        doc.getMap("shapes").set(key, value);
        listeners.get("apps:yjs:update")!({ appId, update: Y.encodeStateAsUpdate(doc, before) });
      },
      // What a native client does when it reconnects: sync its local copy,
      // then send the server whatever that copy has and the server lacks.
      resync: (appId: string) => {
        const response = ask<{ syncMessage: Uint8Array; stateVector: Uint8Array }>(
          "apps:yjs:sync",
          { appId, syncMessage: Y.encodeStateVector(doc) },
        );
        Y.applyUpdate(doc, response.syncMessage);
        listeners.get("apps:yjs:update")!({
          appId,
          update: Y.encodeStateAsUpdate(doc, response.stateVector),
        });
      },
      sendAwareness: (appId: string, awareness: Awareness) =>
        listeners.get("apps:awareness")!({
          appId,
          awarenessUpdate: encodeAwarenessUpdate(awareness, [awareness.clientID]),
          clientId: awareness.clientID,
        }),
      // What a client that joins (or returns to) the app now receives.
      coldSync: (appId: string) => {
        const response = ask<{ syncMessage?: Uint8Array; error?: string }>("apps:yjs:sync", {
          appId,
          syncMessage: Y.encodeStateVector(new Y.Doc()),
        });
        if (!response.syncMessage) return { error: response.error };
        const fresh = new Y.Doc();
        Y.applyUpdate(fresh, response.syncMessage);
        return { shapes: Array.from(fresh.getMap("shapes").keys()).sort() };
      },
    };
  };

  return { room, broadcasts, join };
};

const lastState = (broadcasts: Sent[]): AppsState =>
  broadcasts.filter((sent) => sent.event === "apps:state").at(-1)!.payload as AppsState;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("presenting apps keeps their documents", () => {
  it("brings the same strokes back when the host presents another app and returns", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    expect(host.present("whiteboard").success).toBe(true);
    host.draw("whiteboard", "circle");
    guest.draw("whiteboard", "arrow");

    expect(host.present("watch").success).toBe(true);
    expect(guest.coldSync("whiteboard")).toEqual({ error: "App not active" });

    expect(host.present("whiteboard").success).toBe(true);
    expect(guest.coldSync("whiteboard")).toEqual({ shapes: ["arrow", "circle"] });
  });

  it("keeps the board when the host closes it, from an older client too", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    expect(host.closeLegacy().success).toBe(true);
    expect(host.state()).toMatchObject({ activeAppId: null, savedAppIds: ["whiteboard"] });

    host.present("whiteboard");
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("drops updates and presence for an app that is not on the stage", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");

    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    host.present("watch");
    guest.draw("whiteboard", "late-stroke");
    guest.sendAwareness("whiteboard", new Awareness(new Y.Doc()));

    expect(guest.relayed.map((sent) => sent.event)).toEqual(["apps:yjs:update"]);
    host.present("whiteboard");
    expect(guest.coldSync("whiteboard")).toEqual({ shapes: ["circle"] });
  });

  it("removes everyone's presence from the app that leaves the stage", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");
    host.present("whiteboard");
    const cursor = new Awareness(new Y.Doc());
    cursor.setLocalState({ user: { id: "guest#1" } });
    guest.sendAwareness("whiteboard", cursor);

    host.present("watch");

    const removal = broadcasts.find((sent) => sent.event === "apps:awareness");
    expect(removal?.payload).toMatchObject({ appId: "whiteboard" });
  });
});

describe("clearing an app", () => {
  it("erases a closed board for everyone", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    host.close(host.state().revision);

    expect(host.discard("whiteboard", host.state().revision).success).toBe(true);
    expect(lastState(broadcasts).savedAppIds).toEqual([]);

    host.present("whiteboard");
    expect(host.coldSync("whiteboard")).toEqual({ shapes: [] });
  });

  it("takes the presented app off the stage when it is cleared", () => {
    const { join, broadcasts } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");

    expect(host.discard("whiteboard").success).toBe(true);
    expect(lastState(broadcasts)).toMatchObject({ activeAppId: null, savedAppIds: [] });
  });

  it("stays cleared when a client that missed the clear resyncs its old copy", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const away = join("native#1", "participant");
    host.present("whiteboard");
    away.draw("whiteboard", "circle");
    host.draw("whiteboard", "arrow");

    host.close(host.state().revision);
    host.discard("whiteboard", host.state().revision);
    host.present("whiteboard");
    const fresh = join("fresh#1", "participant");
    fresh.draw("whiteboard", "square");
    away.relayed.length = 0;

    away.resync("whiteboard");
    away.draw("whiteboard", "circle", "moved");
    away.draw("whiteboard", "late-stroke");

    expect(away.relayed).toEqual([]);
    expect(join("late#1", "participant").coldSync("whiteboard")).toEqual({ shapes: ["square"] });
  });

  it("starts a cleared app on a new document generation", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    const first = host.state().docGeneration;

    host.lock(true);
    host.present("watch");
    host.present("whiteboard");
    expect(host.state().docGeneration).toBe(first);

    host.discard("whiteboard");
    expect(host.state().docGeneration).toBeNull();
    host.present("whiteboard");
    expect(host.state().docGeneration).not.toBe(first);
    expect(host.state().docGeneration).toEqual(expect.any(Number));
  });

  it("is only for hosts", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const guest = join("guest#1", "participant");
    host.present("whiteboard");
    guest.draw("whiteboard", "circle");
    host.present("watch");

    expect(guest.discard("whiteboard")).toMatchObject({ success: false });
    expect(guest.present("whiteboard")).toMatchObject({ success: false });
    expect(guest.closeLegacy()).toMatchObject({ success: false });
    expect(host.state()).toMatchObject({ activeAppId: "watch", savedAppIds: ["whiteboard"] });
  });
});

describe("stage revision", () => {
  it("rejects a stage command made against an older stage", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    const seen = first.state().revision;

    expect(second.present("watch", seen).success).toBe(true);
    expect(first.present("whiteboard", seen)).toEqual({
      success: false,
      error: "The stage changed. Try again.",
      code: "stale_revision",
    });
    expect(first.discard("watch", seen)).toMatchObject({ success: false });
    expect(first.state().activeAppId).toBe("watch");
  });

  it("accepts a repeated command for the state the room is already in", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    const seen = first.state().revision;

    second.present("whiteboard", seen);
    expect(first.present("whiteboard", seen).success).toBe(true);
    second.close(first.state().revision);
    expect(first.close(seen).success).toBe(true);
  });

  it("moves forward with every change older clients can make", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    const revisions = [host.state().revision];
    host.present("whiteboard");
    revisions.push(host.state().revision);
    host.lock(true);
    revisions.push(host.state().revision);
    host.closeLegacy();
    revisions.push(host.state().revision);

    expect(new Set(revisions).size).toBe(revisions.length);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });

  it("rejects a lock made against an older stage", () => {
    const { join } = makeRoom();
    const first = join("host#1", "host");
    const second = join("host#2", "host");
    first.present("whiteboard");
    const seen = first.state().revision;

    second.present("watch", seen);

    expect(first.lock(true, seen)).toMatchObject({ success: false });
    expect(first.state()).toMatchObject({ activeAppId: "watch", locked: false });
  });

  it("limits how fast one host can change the stage", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    const outcomes = Array.from({ length: 12 }, (_, index) => host.lock(index % 2 === 0).success);

    expect(outcomes.slice(0, 9).every(Boolean)).toBe(true);
    expect(outcomes.at(-1)).toBe(false);
    expect(host.present("watch")).toEqual({ success: false, error: "Too many app changes" });
  });

  it("starts a newly presented app unlocked", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.lock(true);
    host.present("watch");
    expect(host.state().locked).toBe(false);
  });
});

describe("room document budget", () => {
  it("tells the host the room is full so they can clear an app", () => {
    const { join } = makeRoom();
    const host = join("host#1", "host");
    for (let index = 0; index < MAX_ROOM_APP_DOCS; index += 1) {
      host.present(`app-${index}`);
      host.draw(`app-${index}`, "mark");
    }

    expect(host.present("one-more")).toEqual({
      success: false,
      error: "Clear an app to present another.",
      code: "room_full",
    });
  });

  const fill = (apps: RoomApps, appId: string, bytes: number) => {
    const source = new Y.Doc();
    const update = (() => {
      source.getText("t").insert(0, "x".repeat(bytes));
      return Y.encodeStateAsUpdate(source);
    })();
    expect(apps.reserveUpdate(appId, update)).toBe(true);
    Y.applyUpdate(apps.liveDoc(appId)!, update);
  };

  it("does not keep apps nobody wrote to", () => {
    const apps = new RoomApps();
    for (let index = 0; index < MAX_ROOM_APP_DOCS * 3; index += 1) {
      expect(apps.present(`app-${index}`).ok).toBe(true);
    }
    expect(apps.snapshot().savedAppIds).toEqual([]);
  });

  it("refuses another document once the room keeps its limit of apps", () => {
    const apps = new RoomApps();
    for (let index = 0; index < MAX_ROOM_APP_DOCS; index += 1) {
      apps.present(`app-${index}`);
      fill(apps, `app-${index}`, 10);
    }
    expect(apps.present("one-more")).toEqual({ ok: false, reason: "full" });
    expect(apps.present("app-0").ok).toBe(true);

    apps.discard("app-1");
    expect(apps.present("one-more").ok).toBe(true);
  });

  it("refuses another document when the room has no space for it to grow", () => {
    const apps = new RoomApps();
    for (let index = 0; index < 4; index += 1) {
      expect(apps.present(`board-${index}`).ok).toBe(true);
      fill(apps, `board-${index}`, MAX_APP_DOC_BYTES - 1024);
    }
    expect(apps.present("board-4")).toEqual({ ok: false, reason: "full" });
  });

  it("stops the presented document at the room's remaining space", () => {
    const apps = new RoomApps();
    for (let index = 0; index < 4; index += 1) {
      apps.present(`board-${index}`);
      fill(apps, `board-${index}`, (MAX_APP_DOC_BYTES * 3) / 4 - 1024);
    }
    expect(apps.present("board-4").ok).toBe(true);
    fill(apps, "board-4", MAX_APP_DOC_BYTES - 1024);
    apps.present("board-0");

    const source = new Y.Doc();
    source.getText("u").insert(0, "y".repeat(200 * 1024));
    const update = Y.encodeStateAsUpdate(source);
    expect(apps.reserveUpdate("board-0", update)).toBe(false);

    apps.discard("board-4");
    expect(apps.reserveUpdate("board-0", update)).toBe(true);
  });

  it("destroys every document when the room is torn down", () => {
    const { room, join } = makeRoom();
    const host = join("host#1", "host");
    host.present("whiteboard");
    host.draw("whiteboard", "circle");
    host.present("watch");

    room.close();

    expect(host.state()).toMatchObject({ activeAppId: null, savedAppIds: [] });
    host.present("whiteboard");
    expect(host.coldSync("whiteboard")).toEqual({ shapes: [] });
  });
});
