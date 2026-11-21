import { describe, expect, it } from "vitest";
import type { Router } from "mediasoup/types";
import type { Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerWebinarInteractionHandlers } from "../server/socket/handlers/webinarInteractionHandlers.js";
import type { SfuState } from "../server/state.js";
import type { WebinarRoomConfig } from "../server/webinar.js";
import {
  emitQaSnapshotTo,
  emitWebinarConfigChanged,
} from "../server/webinarNotifications.js";
import type { WebinarQaChangedNotification, WebinarQaEntry } from "../types.js";

type Handler = (...args: unknown[]) => void;
type Ack = { error?: string; id?: string; upvotes?: number };

const fakeRouter = (): Router => {
  const state = { closed: false };
  return {
    get closed() {
      return state.closed;
    },
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close() {
      state.closed = true;
    },
  } as unknown as Router;
};

/** What one person's Q&A list shows after applying every event they got. */
const createRoom = (options: { webinar?: boolean } = {}) => {
  const room = new Room({
    id: "room",
    clientId: "default",
    router: fakeRouter(),
    workerPid: null,
  });
  const state = {
    webinarConfigs: new Map<string, WebinarRoomConfig>(),
  } as unknown as SfuState;
  const webinarConfig = {
    enabled: Boolean(options.webinar),
    qaEnabled: true,
    maxAttendees: 500,
  } as WebinarRoomConfig;
  state.webinarConfigs.set(room.channelId, webinarConfig);
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        for (const client of room.clients.values()) {
          client.socket.emit(event, payload);
        }
      },
    }),
  } as unknown as ConnectionContext["io"];

  const join = (
    name: string,
    role: "host" | "participant" | "attendee" = "participant",
  ) => {
    const handlers = new Map<string, Handler>();
    const list = new Map<string, WebinarQaEntry>();
    let snapshots = 0;
    const socket = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: (event: string, payload: unknown) => {
        if (event === "webinar:qaSnapshot") {
          snapshots += 1;
          list.clear();
          for (const entry of (payload as { entries: WebinarQaEntry[] }).entries) {
            list.set(entry.id, entry);
          }
        }
        if (event === "webinar:qaChanged") {
          const change = payload as WebinarQaChangedNotification;
          if (change.removedId) list.delete(change.removedId);
          if (change.entry) list.set(change.entry.id, change.entry);
        }
      },
    } as unknown as Socket;
    const id = `${name.toLowerCase()}#1`;
    const client =
      role === "host"
        ? new Admin({ id, socket })
        : new Client({
            id,
            socket,
            mode: role === "attendee" ? "webinar_attendee" : undefined,
          });
    room.addClient(client);
    room.setUserIdentity(id, name.toLowerCase(), name);
    registerWebinarInteractionHandlers({
      socket,
      io,
      state,
      currentRoom: room,
      currentClient: client,
    } as unknown as ConnectionContext);
    emitQaSnapshotTo(state, room, client);

    const call = (event: string, payload: unknown): Ack => {
      let response: Ack | undefined;
      handlers.get(event)?.(payload, (value: Ack) => {
        response = value;
      });
      if (!response) throw new Error(`${event} did not ack`);
      return response;
    };
    return {
      ask: (question: string) => call("webinar:qa:submit", { question }),
      upvote: (id: string) => call("webinar:qa:upvote", { id }),
      moderate: (id: string, action: string) =>
        call("webinar:qa:moderate", { id, action }),
      sees: () => Array.from(list.values(), (entry) => entry.question),
      entry: (id: string) => list.get(id),
      snapshots: () => snapshots,
    };
  };

  /** A host setting change, as every webinar config path broadcasts it. */
  const changeWebinarConfig = (change: Partial<WebinarRoomConfig>) => {
    Object.assign(webinarConfig, change);
    emitWebinarConfigChanged(io as never, state, room);
  };

  return { join, changeWebinarConfig };
};

describe("Q&A in a regular meeting", () => {
  it("shows a participant's question to everyone right away", () => {
    const { join } = createRoom();
    join("Hana", "host");
    const asker = join("Gia");
    const other = join("Ben");

    const asked = asker.ask("Can we get the slides?");
    expect(asked.error).toBeUndefined();
    expect(other.sees()).toEqual(["Can we get the slides?"]);

    const late = join("Lou");
    expect(late.sees()).toEqual(["Can we get the slides?"]);
  });

  it("counts upvotes from other participants", () => {
    const { join } = createRoom();
    const asker = join("Gia");
    const other = join("Ben");
    const { id } = asker.ask("When is the next sync?");

    expect(other.upvote(id!).upvotes).toBe(1);
    expect(asker.entry(id!)?.upvotes).toBe(1);
    expect(other.upvote(id!).upvotes).toBe(0);
  });

  it("lets only hosts mark questions answered or hide them", () => {
    const { join } = createRoom();
    const host = join("Hana", "host");
    const asker = join("Gia");
    const other = join("Ben");
    const { id } = asker.ask("Is this recorded?");

    expect(other.moderate(id!, "answered").error).toBe("Only hosts can do this");

    host.moderate(id!, "answered");
    expect(other.entry(id!)?.status).toBe("answered");

    host.moderate(id!, "dismissed");
    expect(other.sees()).toEqual([]);
    expect(asker.entry(id!)?.status).toBe("dismissed");
    expect(host.entry(id!)?.status).toBe("dismissed");
    expect(join("Lou").sees()).toEqual([]);

    host.moderate(id!, "reopen");
    expect(other.entry(id!)?.status).toBe("pending");
  });
});

describe("switching webinar mode", () => {
  it("rebuilds every list under the new rule, and only then", () => {
    const { join, changeWebinarConfig } = createRoom();
    join("Hana", "host");
    const asker = join("Gia");
    const other = join("Ben");
    asker.ask("Can we get the slides?");
    const before = other.snapshots();

    changeWebinarConfig({ maxAttendees: 200 });
    expect(other.snapshots()).toBe(before);

    changeWebinarConfig({ enabled: true });
    expect(other.sees()).toEqual([]);
    expect(asker.sees()).toEqual(["Can we get the slides?"]);

    changeWebinarConfig({ enabled: false });
    expect(other.sees()).toEqual(["Can we get the slides?"]);
  });
});

describe("Q&A in a webinar", () => {
  it("keeps unanswered questions between the asker and the hosts", () => {
    const { join } = createRoom({ webinar: true });
    const host = join("Hana", "host");
    const panelist = join("Pia");
    const asker = join("Ari", "attendee");
    const otherAttendee = join("Abe", "attendee");

    const { id } = asker.ask("Will you share the deck?");
    expect(host.sees()).toEqual(["Will you share the deck?"]);
    expect(otherAttendee.sees()).toEqual([]);
    expect(panelist.ask("Can panelists ask?").error).toBe(
      "Only webinar attendees can do this",
    );

    host.moderate(id!, "answering");
    expect(otherAttendee.entry(id!)?.status).toBe("answering");
  });
});
