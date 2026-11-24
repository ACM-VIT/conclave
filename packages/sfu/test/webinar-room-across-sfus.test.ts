import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config/config.js";
import { createMemoryBackend, createMemoryData, type MemoryData } from "../server/controlPlane/backends/memory.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { createWebinar, deleteWebinar, updateWebinar, webinarById } from "../server/controlPlane/webinarCommands.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { getRoomChannelId } from "../server/rooms.js";
import { advanceScheduledWebinars, ensureWebinarRoomConfig } from "../server/scheduledWebinarScheduler.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { hashWebinarInviteCode } from "../server/webinar.js";
import type { ScheduledWebinar } from "../types.js";

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

const roomConfig = (sfu: SfuState, webinar: ScheduledWebinar) =>
  sfu.webinarConfigs.get(getRoomChannelId(webinar.clientId, webinar.roomId));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("a scheduled webinar's room on the SFU that hosts it", () => {
  it("requires the invite code that another SFU set", async () => {
    const data = createMemoryData();
    const [handling, hosting] = [sfuOn(data, "handling"), sfuOn(data, "hosting")];
    const webinar = await created(handling, { inviteCode: "Secret-42" });
    const stored = await hosting.controlPlane.read(webinarById(webinar.id));
    expect(ensureWebinarRoomConfig(hosting, stored!).inviteCodeHash).toBe(hashWebinarInviteCode("Secret-42"));

    const changed = await handling.controlPlane.commit(updateWebinar(webinar.id, { inviteCode: "Other-7" }, admin));
    expect(changed.ok).toBe(true);
    await advanceScheduledWebinars(hosting);
    expect(roomConfig(hosting, webinar)?.inviteCodeHash).toBe(hashWebinarInviteCode("Other-7"));

    expect((await handling.controlPlane.commit(updateWebinar(webinar.id, { inviteCode: null }, admin))).ok).toBe(true);
    await advanceScheduledWebinars(hosting);
    expect(roomConfig(hosting, webinar)?.inviteCodeHash).toBeNull();
  });

  it("is locked when another SFU ends the webinar, and closed when another SFU cancels or deletes it", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const ended = await created(other, { linkSlug: "ends-elsewhere" });
    const cancelled = await created(other, { linkSlug: "cancels-elsewhere" });
    const deleted = await created(other, { linkSlug: "goes-elsewhere" });
    for (const webinar of [ended, cancelled, deleted]) ensureWebinarRoomConfig(hosting, webinar);
    expect(roomConfig(hosting, ended)).toMatchObject({ enabled: true, locked: false });

    await other.controlPlane.commit(updateWebinar(ended.id, { status: "ended" }, admin));
    await other.controlPlane.commit(updateWebinar(cancelled.id, { status: "cancelled" }, admin));
    await other.controlPlane.commit(deleteWebinar(deleted.id, admin));
    await advanceScheduledWebinars(hosting);

    expect(roomConfig(hosting, ended)).toMatchObject({ enabled: true, locked: true });
    expect(roomConfig(hosting, cancelled)).toMatchObject({ enabled: false, locked: true });
    expect(roomConfig(hosting, deleted)).toMatchObject({ enabled: false, scheduledWebinarId: null, linkSlug: null });
  });

  it("takes schedule edits made on another SFU", async () => {
    const data = createMemoryData();
    const [hosting, other] = [sfuOn(data, "hosting"), sfuOn(data, "other")];
    const webinar = await created(other, { maxAttendees: 100 });
    ensureWebinarRoomConfig(hosting, webinar);
    await other.controlPlane.commit(updateWebinar(webinar.id, { maxAttendees: 250, qaEnabled: false }, admin));
    await advanceScheduledWebinars(hosting);
    expect(roomConfig(hosting, webinar)).toMatchObject({ maxAttendees: 250, qaEnabled: false });
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
