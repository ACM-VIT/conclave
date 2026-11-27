import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryBackend } from "../server/controlPlane/backends/memory.js";
import {
  createMeeting,
  deleteMeeting,
  meetingById,
  meetingByRoomCode,
  updateMeeting,
} from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { controlPlaneStore, type ControlPlaneStore } from "../server/controlPlane/store.js";
import type { ScheduledMeeting } from "../types.js";

const dirs: string[] = [];
const stores: ControlPlaneStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const options = {
  clientId: "conclave",
  createdBy: "host@example.com",
  defaultHostEmail: "host@example.com",
  defaultHostUserId: null,
};
const host = { email: "host@example.com", isAdmin: false };
const request = (startOffsetMs: number) => ({
  title: "Standup",
  scheduledStartAt: Date.now() + startOffsetMs,
  roomCode: "standup-room",
});

const memoryStore = (): ControlPlaneStore => controlPlaneStore(createMemoryBackend());

const created = async (store: ControlPlaneStore, offsetMs: number): Promise<ScheduledMeeting> => {
  const result = await store.commit(createMeeting(request(offsetMs), options));
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const setStatus = async (
  store: ControlPlaneStore,
  meeting: ScheduledMeeting,
  status: ScheduledMeeting["status"],
): Promise<void> => {
  const result = await store.commit(updateMeeting(meeting.id, { status }, host));
  if (!result.ok) throw new Error(result.message);
};

describe("scheduled meeting room-code reuse", () => {
  it("persists a meeting that reuses an ended meeting's code, and reloads both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-"));
    dirs.push(dir);
    const config = {
      ...resolveControlPlaneConfig({ CONTROL_PLANE_PERSISTENCE: "sqlite" }),
      sqlitePath: join(dir, "conclave.sqlite"),
    };
    const store = await openControlPlane(config, { importLegacy: false });
    const first = await created(store, 3_600_000);
    await setStatus(store, first, "ended");
    const second = await created(store, 7_200_000);
    expect(second.roomCode).toBe(first.roomCode);
    await store.close();

    const reloaded = await openControlPlane(config, { importLegacy: false });
    stores.push(reloaded);
    expect(await reloaded.read(meetingById(first.id))).not.toBeNull();
    expect(await reloaded.read(meetingById(second.id))).not.toBeNull();
    expect((await reloaded.read(meetingByRoomCode("conclave", "standup-room")))?.id).toBe(second.id);
  });

  it("keeps the active meeting findable by code when the ended one is deleted", async () => {
    const store = memoryStore();
    const first = await created(store, 3_600_000);
    await setStatus(store, first, "ended");
    const second = await created(store, 7_200_000);
    expect((await store.commit(deleteMeeting(first.id, host))).ok).toBe(true);
    expect((await store.read(meetingByRoomCode("conclave", "standup-room")))?.id).toBe(second.id);
  });

  it("points the code at a meeting that is reactivated", async () => {
    const store = memoryStore();
    const first = await created(store, 3_600_000);
    await setStatus(store, first, "ended");
    const second = await created(store, 7_200_000);
    await setStatus(store, second, "ended");
    await setStatus(store, first, "scheduled");
    expect((await store.read(meetingByRoomCode("conclave", "standup-room")))?.id).toBe(first.id);
  });

  it("refuses to reactivate a meeting whose code another active meeting holds", async () => {
    const store = memoryStore();
    const first = await created(store, 3_600_000);
    await setStatus(store, first, "ended");
    const second = await created(store, 7_200_000);
    const refused = await store.commit(
      updateMeeting(first.id, { status: "live", title: "Renamed" }, host),
    );
    expect(refused).toEqual({
      ok: false,
      reason: "invalid",
      message: "That meeting code is already booked.",
    });
    const stored = await store.read(meetingById(first.id));
    expect(stored?.status).toBe("ended");
    expect(stored?.title).toBe("Standup");
    expect((await store.read(meetingByRoomCode("conclave", "standup-room")))?.id).toBe(second.id);
  });
});
