import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  deleteScheduledMeeting,
  getScheduledMeetingByRoomCode,
  loadPersistedMeetings,
  updateScheduledMeeting,
} from "../server/scheduledMeetings.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const options = {
  clientId: "conclave",
  createdBy: "host@example.com",
  defaultHostEmail: "host@example.com",
  defaultHostUserId: null,
};
const request = (startOffsetMs: number) => ({
  title: "Standup",
  scheduledStartAt: Date.now() + startOffsetMs,
  roomCode: "standup-room",
});

describe("scheduled meeting room-code reuse", () => {
  it("persists a meeting that reuses an ended meeting's code, and reloads both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-"));
    dirs.push(dir);
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
    vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", join(dir, "conclave.sqlite"));
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("SFU_REDIS_URL", "");
    vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", "");

    const persistence = createScheduledMeetingPersistence();
    const store = createScheduledMeetingStore();
    const first = createScheduledMeeting(store, request(3_600_000), options);
    updateScheduledMeeting(store, first.id, { status: "ended" });
    const second = createScheduledMeeting(store, request(7_200_000), options);
    expect(second.roomCode).toBe(first.roomCode);
    await persistence.saveChanged?.([first, second]);

    const reloaded = createScheduledMeetingStore();
    await loadPersistedMeetings(reloaded, createScheduledMeetingPersistence());
    expect(reloaded.byId.has(first.id)).toBe(true);
    expect(reloaded.byId.has(second.id)).toBe(true);
    expect(getScheduledMeetingByRoomCode(reloaded, "conclave", "standup-room")?.id).toBe(second.id);
  });

  it("keeps the active meeting findable by code when the ended one is deleted", () => {
    const store = createScheduledMeetingStore();
    const first = createScheduledMeeting(store, request(3_600_000), options);
    updateScheduledMeeting(store, first.id, { status: "ended" });
    const second = createScheduledMeeting(store, request(7_200_000), options);
    deleteScheduledMeeting(store, first.id);
    expect(getScheduledMeetingByRoomCode(store, "conclave", "standup-room")?.id).toBe(second.id);
  });

  it("points the code at a meeting that is reactivated", () => {
    const store = createScheduledMeetingStore();
    const first = createScheduledMeeting(store, request(3_600_000), options);
    updateScheduledMeeting(store, first.id, { status: "ended" });
    const second = createScheduledMeeting(store, request(7_200_000), options);
    updateScheduledMeeting(store, second.id, { status: "ended" });
    updateScheduledMeeting(store, first.id, { status: "scheduled" });
    expect(getScheduledMeetingByRoomCode(store, "conclave", "standup-room")?.id).toBe(first.id);
  });

  it("refuses to reactivate a meeting whose code another active meeting holds", () => {
    const store = createScheduledMeetingStore();
    const first = createScheduledMeeting(store, request(3_600_000), options);
    updateScheduledMeeting(store, first.id, { status: "ended" });
    const second = createScheduledMeeting(store, request(7_200_000), options);
    expect(() => updateScheduledMeeting(store, first.id, { status: "live", title: "Renamed" })).toThrow(
      "That meeting code is already booked.",
    );
    expect(first.status).toBe("ended");
    expect(first.title).toBe("Standup");
    expect(getScheduledMeetingByRoomCode(store, "conclave", "standup-room")?.id).toBe(second.id);
  });
});
