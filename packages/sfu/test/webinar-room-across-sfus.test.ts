import { createServer, type Server } from "node:http";
import type { Server as SocketIOServer } from "socket.io";
import type { Router } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createMemoryBackend, createMemoryData, type MemoryData } from "../server/controlPlane/backends/memory.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import {
  createWebinar,
  deleteWebinar,
  recordWebinarJoin,
  updateWebinar,
  webinarById,
} from "../server/controlPlane/webinarCommands.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { cleanupRoom, getRoomChannelId } from "../server/rooms.js";
import { advanceScheduledWebinars, notifyRoomConfig, refreshWebinarRoomConfig } from "../server/scheduledWebinarScheduler.js";
import { createSfuState, type SfuState } from "../server/state.js";
import {
  clearWebinarLinkSlug,
  getOrCreateWebinarRoomConfig,
  hashWebinarInviteCode,
  rotateWebinarLinkSlug,
  setCustomWebinarLinkSlug,
} from "../server/webinar.js";
import type { ScheduledWebinar } from "../types.js";
import { readRoomConfig as roomConfig, seedRoomConfig } from "./fixtures/webinar-room.js";

const policySink = vi.hoisted(() => ({ current: null as Array<{ event: string; payload: string }> | null }));

vi.mock("../server/apps/authority/index.js", async (original) => ({
  ...(await original<typeof import("../server/apps/authority/index.js")>()),
  notifyAuthorityPolicy: (state: SfuState, channelId: string) => {
    if (state.rooms.has(channelId)) policySink.current?.push({ event: "authority:policyChanged", payload: JSON.stringify(channelId) });
  },
}));

const admin = { email: null, isAdmin: true };
const options = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test" };

const sfuOn = (data: MemoryData, name: string): SfuState =>
  createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: name, instanceUrl: "http://localhost", ttlMs: 45000 }),
    controlPlane: controlPlaneStore(createMemoryBackend(data)),
  });

const created = async (sfu: SfuState, request: Record<string, unknown>): Promise<ScheduledWebinar> => {
  const result = await sfu.controlPlane.commit(
    createWebinar({ title: "Launch", scheduledStartAt: Date.now() - 60_000, ...request }, options),
  );
  if (!result.ok) throw new Error(result.message);
  return result.value.webinar;
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("a scheduled webinar's room on the SFU that hosts it", () => {
  it("requires the invite code that another SFU set", async () => {
    const data = createMemoryData();
    const [handling, hosting] = [sfuOn(data, "handling"), sfuOn(data, "hosting")];
    const webinar = await created(handling, { inviteCode: "Secret-42" });
    expect((await seedRoomConfig(hosting, webinar)).inviteCodeHash).toBe(hashWebinarInviteCode("Secret-42"));

    const changed = await handling.controlPlane.commit(updateWebinar(webinar.id, { inviteCode: "Other-7" }, admin));
    expect(changed.ok).toBe(true);
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(roomConfig(hosting, webinar)?.inviteCodeHash).toBe(hashWebinarInviteCode("Other-7"));

    expect((await handling.controlPlane.commit(updateWebinar(webinar.id, { inviteCode: null }, admin))).ok).toBe(true);
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(roomConfig(hosting, webinar)?.inviteCodeHash).toBeNull();
  });

  it("is locked when another SFU ends the webinar, and closed when another SFU cancels or deletes it", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const ended = await created(other, { linkSlug: "ends-elsewhere" });
    const cancelled = await created(other, { linkSlug: "cancels-elsewhere" });
    const deleted = await created(other, { linkSlug: "goes-elsewhere" });
    for (const webinar of [ended, cancelled, deleted]) await seedRoomConfig(hosting, webinar);
    expect(roomConfig(hosting, ended)).toMatchObject({ enabled: true, locked: false });

    await other.controlPlane.commit(updateWebinar(ended.id, { status: "ended" }, admin));
    await other.controlPlane.commit(updateWebinar(cancelled.id, { status: "cancelled" }, admin));
    await other.controlPlane.commit(deleteWebinar(deleted.id, admin));
    await advanceScheduledWebinars(hosting, Date.now(), () => {});

    expect(roomConfig(hosting, ended)).toMatchObject({ enabled: true, locked: true });
    expect(roomConfig(hosting, cancelled)).toMatchObject({ enabled: false, locked: true });
    expect(roomConfig(hosting, deleted)).toMatchObject({ enabled: false, scheduledWebinarId: null, linkSlug: null });
  });

  it("takes schedule edits made on another SFU", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const webinar = await created(other, { maxAttendees: 100 });
    await seedRoomConfig(hosting, webinar);
    await other.controlPlane.commit(updateWebinar(webinar.id, { maxAttendees: 250, qaEnabled: false }, admin));
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(roomConfig(hosting, webinar)).toMatchObject({ maxAttendees: 250, qaEnabled: false });
  });

  it("only publishes the persisted schedule in its own tenant and room", async () => {
    const state = sfuOn(createMemoryData(), "scoped-publication");
    const webinar = await created(state, { linkSlug: "scoped-link" });
    const wrongTenant = { ...webinar, clientId: "other-tenant" };
    const wrongRoom = { ...webinar, roomId: "other-room" };
    const notify = vi.fn();
    await refreshWebinarRoomConfig(state, wrongTenant, notify);
    await refreshWebinarRoomConfig(state, wrongRoom, notify);
    expect(notify).not.toHaveBeenCalled();
    expect(state.webinarConfigs.size).toBe(0);
    expect(state.webinarLinks.has(webinar.linkSlug)).toBe(false);

    await refreshWebinarRoomConfig(state, webinar, notify);
    expect(roomConfig(state, webinar)?.scheduledWebinarId).toBe(webinar.id);
    expect(notify).toHaveBeenCalledExactlyOnceWith(getRoomChannelId(webinar.clientId, webinar.roomId));
  });
});

describe("a live webinar's rotated link", () => {
  it("keeps working while attendees join, and gives way only to a new link code in the schedule", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const webinar = await created(other, { linkSlug: "stored-code" });
    const config = await seedRoomConfig(hosting, webinar);
    const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
    const rotated = rotateWebinarLinkSlug({
      webinarConfig: config,
      webinarLinks: hosting.webinarLinks,
      room: { channelId, id: webinar.roomId, clientId: webinar.clientId },
    });
    await other.controlPlane.commit(recordWebinarJoin(webinar.id, 3));
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(config.linkSlug).toBe(rotated);
    expect(hosting.webinarLinks.get(rotated)?.roomChannelId).toBe(channelId);

    await other.controlPlane.commit(updateWebinar(webinar.id, { linkSlug: "new-code" }, admin));
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(config.linkSlug).toBe("new-code");
  });
});

describe("a new link code saved for a live webinar", () => {
  it("binds once another room on the SFU lets go of it", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const webinar = await created(other, { linkSlug: "first-code" });
    const config = await seedRoomConfig(hosting, webinar);
    const squatter = getOrCreateWebinarRoomConfig(hosting.webinarConfigs, "conclave:squatter");
    setCustomWebinarLinkSlug({
      webinarConfig: squatter,
      webinarLinks: hosting.webinarLinks,
      room: { channelId: "conclave:squatter", id: "squatter", clientId: "conclave" },
      slug: "wanted-code",
    });
    await other.controlPlane.commit(updateWebinar(webinar.id, { linkSlug: "wanted-code" }, admin));
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(config.linkSlug).toBe("first-code");

    clearWebinarLinkSlug({ webinarConfig: squatter, webinarLinks: hosting.webinarLinks, roomChannelId: "conclave:squatter" });
    await advanceScheduledWebinars(hosting, Date.now(), () => {});
    expect(config.linkSlug).toBe("wanted-code");
    expect(hosting.webinarLinks.get("wanted-code")?.roomChannelId).toBe(getRoomChannelId(webinar.clientId, webinar.roomId));
  });
});

describe("the webinar API", () => {
  it("never returns the stored invite code hash", async () => {
    const state = sfuOn(createMemoryData(), "api");
    const server = createServer(createSfuApp({ state, config, getIo: () => null }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          "x-sfu-secret": config.sfuSecret,
          "content-type": "application/json",
          "x-user-email": "host@example.test",
          "x-user-id": "host",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await response.json()) as { scheduledWebinar: Record<string, unknown>; scheduledWebinars?: Array<Record<string, unknown>> };
    };
    const made = await call("POST", "/scheduled-webinars", { title: "Launch", scheduledStartAt: Date.now() + 60_000, inviteCode: "Secret-42", linkSlug: "hidden-code" });
    expect(made.scheduledWebinar.requiresInviteCode).toBe(true);
    expect(made.scheduledWebinar).not.toHaveProperty("inviteCodeHash");
    expect(await call("GET", "/scheduled-webinars/by-slug/hidden-code")).not.toHaveProperty("scheduledWebinar.inviteCodeHash");
    const listed = await call("GET", "/scheduled-webinars");
    expect(listed.scheduledWebinars?.[0]).not.toHaveProperty("inviteCodeHash");
  });
});

describe("hosts connected to the SFU that hosts a webinar's room", () => {
  it("are told when another SFU changes or deletes the webinar, and not on a tick that changes nothing", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const webinar = await created(other, { linkSlug: "first-code" });
    await seedRoomConfig(hosting, webinar);
    const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
    const told: string[] = [];
    const notify = (channel: string) => told.push(channel);
    await advanceScheduledWebinars(hosting, Date.now(), notify);
    told.length = 0;

    await advanceScheduledWebinars(hosting, Date.now(), notify);
    expect(told).toEqual([]);
    expect((await other.controlPlane.commit(updateWebinar(webinar.id, { linkSlug: "second-code" }, admin))).ok).toBe(true);
    await advanceScheduledWebinars(hosting, Date.now(), notify);
    expect(roomConfig(hosting, webinar)?.linkSlug).toBe("second-code");
    expect(told).toEqual([channelId]);

    told.length = 0;
    expect((await other.controlPlane.commit(deleteWebinar(webinar.id, admin))).ok).toBe(true);
    await advanceScheduledWebinars(hosting, Date.now(), notify);
    expect(told).toEqual([channelId]);
  });

  it("get the room's new webinar settings as webinar:configChanged and its cap as webinar:attendeeCountChanged", async () => {
    const data = createMemoryData();
    const hosting = sfuOn(data, "hosting");
    const webinar = await created(hosting, { linkSlug: "shared-code" });
    await seedRoomConfig(hosting, webinar);
    const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
    hosting.rooms.set(channelId, {
      channelId,
      id: webinar.roomId,
      clients: new Map(),
      getWebinarAttendeeCount: () => 0,
      getWebinarHandQueue: () => [],
      getAdmins: () => [],
    } as unknown as Room);
    const emitted: Array<{ channel: string; event: string; snapshot: { linkSlug?: string | null } }> = [];
    const io = {
      to: (channel: string) => ({
        emit: (event: string, snapshot: { linkSlug?: string | null }) => emitted.push({ channel, event, snapshot }),
      }),
    } as unknown as SocketIOServer;

    notifyRoomConfig(hosting, () => io)(channelId);
    expect(emitted).toMatchObject([
      { channel: channelId, event: "webinar:configChanged", snapshot: { linkSlug: "shared-code" } },
      { channel: channelId, event: "webinar:attendeeCountChanged" },
    ]);
  });
});

type Emitted = { event: string; payload: string };

const recordingIo = () => {
  const emitted: Emitted[] = [];
  const io = {
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload: JSON.stringify(payload) }) }),
  } as unknown as SocketIOServer;
  policySink.current = emitted;
  return { io, emitted };
};

type Call = (method: string, path: string, body?: unknown, email?: string) => Promise<Record<string, unknown>>;

const apiOn = async (state: SfuState, io: SocketIOServer | null): Promise<Call> => {
  const server = createServer(createSfuApp({ state, config, getIo: () => io }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return async (method, path, body, email = "host@example.test") => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "x-sfu-secret": config.sfuSecret, "content-type": "application/json", "x-user-email": email, "x-user-id": email },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reply = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(reply)}`);
    return reply;
  };
};

it.each([
  { change: "newer edit", room: "present", delay: "commit" },
  { change: "deletion", room: "present", delay: "commit" },
  { change: "deletion", room: "torn down", delay: "commit" },
  { change: "deletion", room: "torn down", delay: "read" },
  { change: "deletion", room: "never seeded", delay: "read" },
] as const)("keeps the effect of $change after a delayed $delay (room $room)", async ({ change, room, delay }) => {
  const state = sfuOn(createMemoryData(), "deferred-webinar");
  const call = await apiOn(state, null);
  const webinar = await created(state, {});
  if (room !== "never seeded") await seedRoomConfig(state, webinar);
  const path = `/scheduled-webinars/${webinar.id}`;
  let didRecord = () => {};
  let resume = () => {};
  const recorded = new Promise<void>((resolve) => { didRecord = resolve; });
  const deferred = new Promise<void>((resolve) => { resume = resolve; });
  const original = state.controlPlane;
  let hold = true;
  const holdOnce = async () => {
    if (!hold) return;
    hold = false;
    didRecord();
    await deferred;
  };
  state.controlPlane = {
    ...original,
    commit: async (command) => {
      const result = await original.commit(command);
      if (delay === "commit") await holdOnce();
      return result;
    },
    read: async (query) => {
      const result = await original.read(query);
      if (delay === "read") await holdOnce();
      return result;
    },
  };

  const earlier = call("PATCH", path, { publicAccess: true, linkSlug: "earlier-code" });
  await recorded;
  try {
    if (change === "newer edit") {
      await call("PATCH", path, { publicAccess: false, linkSlug: "latest-code", inviteCode: "New-pass-42" });
    } else {
      await call("DELETE", path);
      if (room === "torn down") {
        const liveRoom = new Room({
          id: webinar.roomId,
          clientId: webinar.clientId,
          workerPid: null,
          router: { close: () => {} } as Router,
        });
        state.rooms.set(liveRoom.channelId, liveRoom);
        expect(cleanupRoom(state, liveRoom)).toBe(true);
        expect(roomConfig(state, webinar)).toBeUndefined();
      }
    }
  } finally {
    resume();
    await earlier;
  }

  expect(state.webinarLinks.has("earlier-code")).toBe(false);
  if (room !== "present") {
    expect(roomConfig(state, webinar)).toBeUndefined();
  } else if (change === "deletion") {
    expect(roomConfig(state, webinar)).toMatchObject({ enabled: false, scheduledWebinarId: null });
  } else {
    expect(roomConfig(state, webinar)).toMatchObject({
      publicAccess: false,
      linkSlug: "latest-code",
      inviteCodeHash: hashWebinarInviteCode("New-pass-42"),
    });
  }
});

it.each(["cancel", "end", "auto-end"] as const)("does not publish a stale room after %s before its first refresh", async (action) => {
  const state = sfuOn(createMemoryData(), "concluded-before-first-refresh");
  const call = await apiOn(state, null);
  const now = Date.now();
  const webinar = await created(state, {
    scheduledStartAt: now - 120 * 60_000,
    scheduledEndAt: now - 60 * 60_000,
    linkSlug: "concluded-before-refresh",
  });
  const original = state.controlPlane;
  const started = await original.commit(updateWebinar(webinar.id, { status: "live" }, admin));
  expect(started.ok).toBe(true);

  let captured = () => {};
  let resume = () => {};
  const readCaptured = new Promise<void>((resolve) => { captured = resolve; });
  const hold = new Promise<void>((resolve) => { resume = resolve; });
  let first = true;
  state.controlPlane = {
    ...original,
    read: async (query) => {
      const result = await original.read(query);
      if (first) {
        first = false;
        captured();
        await hold;
      }
      return result;
    },
  };
  const refresh = refreshWebinarRoomConfig(state, webinar, () => {});
  await readCaptured;
  try {
    if (action === "auto-end") {
      await advanceScheduledWebinars(state, now, () => {});
    } else {
      await call("POST", `/scheduled-webinars/${webinar.id}/${action}`);
    }
    expect((await original.read(webinarById(webinar.id)))?.status).toBe(action === "cancel" ? "cancelled" : "ended");
  } finally {
    resume();
    await refresh;
  }
  expect(roomConfig(state, webinar)).toMatchObject({ enabled: false, locked: true });
});

it.each(["PATCH", "DELETE"])("reports a committed %s when the publication read is unavailable", async (method) => {
  const state = sfuOn(createMemoryData(), "publication-read-failure");
  const call = await apiOn(state, null);
  const webinar = await created(state, { linkSlug: "before-outage" });
  await seedRoomConfig(state, webinar);
  const original = state.controlPlane;
  state.controlPlane = {
    ...original,
    read: async () => { throw new Error("storage read unavailable"); },
  };
  const path = `/scheduled-webinars/${webinar.id}`;

  if (method === "PATCH") {
    const reply = await call(method, path, { linkSlug: "saved-during-outage" });
    expect(reply.scheduledWebinar).toMatchObject({ linkSlug: "saved-during-outage" });
    expect(roomConfig(state, webinar)?.linkSlug).toBe("before-outage");
    state.controlPlane = original;
    await advanceScheduledWebinars(state, Date.now(), notifyRoomConfig(state, () => null));
    expect(roomConfig(state, webinar)?.linkSlug).toBe("saved-during-outage");
  } else {
    expect(await call(method, path)).toMatchObject({ success: true, id: webinar.id });
    expect(roomConfig(state, webinar)).toMatchObject({ enabled: false, scheduledWebinarId: null });
    expect(state.webinarLinks.has("before-outage")).toBe(false);
  }
});

it.each([1, 2])("seeds a live webinar after read %i on its first live tick failed", async (failedRead) => {
  const state = sfuOn(createMemoryData(), "first-live-tick");
  const webinar = await created(state, { linkSlug: "recovered-live" });
  const now = Date.now();
  const original = state.controlPlane;
  let reads = 0;
  state.controlPlane = {
    ...original,
    read: async (query) => {
      if (++reads === failedRead) throw new Error("storage read unavailable");
      return original.read(query);
    },
  };

  await expect(advanceScheduledWebinars(state, now, () => {})).rejects.toThrow("storage read unavailable");
  expect((await original.read(webinarById(webinar.id)))?.status).toBe("live");
  expect(roomConfig(state, webinar)).toBeUndefined();
  expect(state.webinarLinks.has("recovered-live")).toBe(false);

  await expect(advanceScheduledWebinars(state, now, () => {})).resolves.toEqual([]);
  expect(roomConfig(state, webinar)?.linkSlug).toBe("recovered-live");
  expect(state.webinarLinks.get("recovered-live")?.roomId).toBe(webinar.roomId);
});

it("still retries the saved slug after a no-op co-host acceptance", async () => {
  const state = sfuOn(createMemoryData(), "cohost-noop-revision");
  const call = await apiOn(state, null);
  const scheduledStartAt = Date.now() + 40 * 60_000;
  const { scheduledWebinar: webinar } = (await call("POST", "/scheduled-webinars", {
    title: "Launch", scheduledStartAt, linkSlug: "first-code",
  })) as { scheduledWebinar: ScheduledWebinar };
  const otherChannel = "conclave:other";
  const other = getOrCreateWebinarRoomConfig(state.webinarConfigs, otherChannel);
  setCustomWebinarLinkSlug({
    webinarConfig: other,
    webinarLinks: state.webinarLinks,
    room: { channelId: otherChannel, id: "other", clientId: "conclave" },
    slug: "pending-code",
  });
  const path = `/scheduled-webinars/${webinar.id}`;
  await call("PATCH", path, { linkSlug: "pending-code" });
  expect(roomConfig(state, webinar)?.linkSlug).toBe("first-code");
  const invite = (await call("POST", `${path}/cohost-invite`)) as { coHostInviteLink: string };
  const token = new URL(invite.coHostInviteLink).pathname.split("/").at(-1);
  await call("POST", "/scheduled-webinars", { title: "Other", scheduledStartAt });
  await call("POST", `/scheduled-webinars/cohost-invites/${token}/accept`);
  clearWebinarLinkSlug({ webinarConfig: other, webinarLinks: state.webinarLinks, roomChannelId: otherChannel });

  await advanceScheduledWebinars(state, Date.now(), () => {});
  expect(roomConfig(state, webinar)?.linkSlug).toBe("pending-code");
});

type RoomChange = (call: Call, webinar: { id: string }, tag: string) => Promise<unknown>;

const roomChanges: Array<[string, RoomChange]> = [
  ["a new link code", (call, webinar, tag) => call("PATCH", `/scheduled-webinars/${webinar.id}`, { linkSlug: `second-${tag}` })],
  ["a new attendee cap and Q&A switch", (call, webinar) => call("PATCH", `/scheduled-webinars/${webinar.id}`, { maxAttendees: 250, qaEnabled: false })],
  ["a new title only", (call, webinar) => call("PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Renamed" })],
  ["ending it", (call, webinar) => call("POST", `/scheduled-webinars/${webinar.id}/end`)],
  ["cancelling it", (call, webinar) => call("POST", `/scheduled-webinars/${webinar.id}/cancel`)],
  ["a co-host accepting an invite", async (call, webinar) => {
    const invite = (await call("POST", `/scheduled-webinars/${webinar.id}/cohost-invite`)) as { coHostInviteLink: string };
    const token = decodeURIComponent(new URL(invite.coHostInviteLink).pathname.split("/").pop() ?? "");
    return call("POST", `/scheduled-webinars/cohost-invites/${token}/accept`, undefined, "cohost@example.test");
  }],
  ["deleting it", (call, webinar) => call("DELETE", `/scheduled-webinars/${webinar.id}`)],
];

const eventsOnHostingSfu = async (change: RoomChange, where: "local" | "remote"): Promise<Emitted[]> => {
  const data = createMemoryData();
  const [hosting, other] = [sfuOn(data, `hosting-${where}`), sfuOn(data, `other-${where}`)];
  const { io, emitted } = recordingIo();
  const [hostingApi, otherApi] = [await apiOn(hosting, io), await apiOn(other, null)];
  const made = (await hostingApi("POST", "/scheduled-webinars", {
    title: "Launch",
    scheduledStartAt: Date.now() - 60_000,
    linkSlug: `first-${where}`,
  })) as { scheduledWebinar: ScheduledWebinar };
  const webinar = made.scheduledWebinar;
  await hostingApi("POST", `/scheduled-webinars/${webinar.id}/start`);
  const notices = notifyRoomConfig(hosting, () => io);
  await advanceScheduledWebinars(hosting, Date.now(), notices);
  const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
  hosting.rooms.set(channelId, {
    channelId,
    id: webinar.roomId,
    clients: new Map(),
    getWebinarAttendeeCount: () => 0,
    getWebinarHandQueue: () => [],
    getAdmins: () => [],
  } as unknown as Room);
  await change(where === "local" ? hostingApi : otherApi, webinar, where);
  await advanceScheduledWebinars(hosting, Date.now(), notices);
  await advanceScheduledWebinars(hosting, Date.now(), notices);
  return emitted.map(({ event, payload }) => ({
    event,
    payload: payload.replaceAll(where, "<sfu>").replaceAll(webinar.roomId, "<room>"),
  }));
};

describe("a webinar change made through this SFU and the same change made through another SFU", () => {
  it.each(roomChanges)("emit the same events to this SFU's room, once, for %s", async (name, change) => {
    const local = await eventsOnHostingSfu(change, "local");
    const remote = await eventsOnHostingSfu(change, "remote");
    expect(remote).toEqual(local);
    if (name === "a new title only") {
      expect(local).toEqual([]);
    } else {
      expect(local.map((entry) => entry.event)).toEqual([
        "authority:policyChanged",
        "webinar:configChanged",
        "webinar:attendeeCountChanged",
      ]);
    }
  });

  it("show hosts the new link code either way", async () => {
    const local = (await eventsOnHostingSfu(roomChanges[0][1], "local")).find((entry) => entry.event === "webinar:configChanged");
    expect(JSON.parse(local?.payload ?? "null")).toMatchObject({ linkSlug: "second-<sfu>" });
  });
});
