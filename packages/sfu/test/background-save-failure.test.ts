import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMeeting } from "../types.js";
import { startBackgroundTimer } from "../server/backgroundTimer.js";
import { initScheduledMeetings } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { changeMeetings, createScheduledMeetingPersistence, createScheduledMeeting } from "../server/scheduledMeetings.js";
import { runScheduledMeetingTick } from "../server/scheduledMeetingTick.js";
import { createSfuState } from "../server/state.js";

let stateDir = "";
let uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);

const dueMeeting = {
  id: "due-meeting", clientId: "conclave", roomCode: "due-room", title: "Due", hostEmail: "host@example.test", hostName: "",
  hostUserId: null, scheduledStartAt: Date.now() - 60_000, scheduledEndAt: Date.now() + 3_600_000, status: "scheduled",
  startedAt: null, endedAt: null, createdAt: 1, createdBy: "host@example.test", updatedAt: 1, source: "manual", eventTypeId: null,
} as unknown as ScheduledMeeting;

const throwSynchronously = () => {
  throw new Error("database is locked");
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-background-save-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
  for (const variable of ["SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULING_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  uncaught = [];
  process.on("uncaughtException", onUncaught);
});

afterEach(() => {
  process.off("uncaughtException", onUncaught);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("a store save that throws synchronously in the background", () => {
  it("reaches changeMeetings' caller as a rejection, never a throw", () => {
    const persistence = { ...createScheduledMeetingPersistence(), saveChanged: throwSynchronously };
    const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "sync-throw", instanceUrl: "http://localhost", ttlMs: 45000 }) });
    const host = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

    let result: Promise<unknown> | undefined;
    expect(() => {
      result = changeMeetings(state.scheduledMeetings, persistence, [], (draft) =>
        createScheduledMeeting(draft, { title: "Planning", scheduledStartAt: Date.now() + 60_000 }, host),
      );
    }).not.toThrow();
    return expect(result).rejects.toThrow(/Could not save scheduled meetings/);
  });

  it("is logged by the meeting tick, which leaves the meeting for the next tick to advance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "tick", instanceUrl: "http://localhost", ttlMs: 45000 }) });
    await initScheduledMeetings(state);
    state.scheduledMeetings.byId.set(dueMeeting.id, { ...dueMeeting });
    vi.spyOn(state.scheduledMeetingPersistence!, "saveChanged").mockImplementationOnce(throwSynchronously);

    await expect(runScheduledMeetingTick(state)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Failed to persist scheduled-meeting tick/);
    expect(state.scheduledMeetings.byId.get(dueMeeting.id)?.status).toBe("scheduled");

    await runScheduledMeetingTick(state);
    expect(state.scheduledMeetings.byId.get(dueMeeting.id)?.status).toBe("live");
    const stored = await state.scheduledMeetingPersistence!.load();
    expect(stored.find((meeting) => meeting.id === dueMeeting.id)?.status).toBe("live");
  });

  it("never escapes a background timer, which keeps ticking", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let ticks = 0;
    const timers = [
      startBackgroundTimer("Throwing tick", 5, () => {
        ticks += 1;
        throwSynchronously();
      }),
      startBackgroundTimer("Rejecting tick", 5, async () => {
        throwSynchronously();
      }),
    ];
    try {
      await vi.waitFor(() => {
        expect(ticks).toBeGreaterThan(2);
        const logged = warn.mock.calls.flat().join(" ");
        expect(logged).toMatch(/Throwing tick failed/);
        expect(logged).toMatch(/Rejecting tick failed/);
      }, { timeout: 5_000, interval: 10 });
    } finally {
      timers.forEach(clearInterval);
    }
    expect(uncaught).toEqual([]);
  });
});
