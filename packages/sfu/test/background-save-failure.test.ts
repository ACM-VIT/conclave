import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMeeting } from "../types.js";
import { startBackgroundTimer } from "../server/backgroundTimer.js";
import { initScheduledMeetings } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createScheduledMeetingPersistence, persistScheduledMeetingChanges } from "../server/scheduledMeetings.js";
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
  it("reaches persistScheduledMeetingChanges' caller as a rejection, never a throw", () => {
    const persistence = { ...createScheduledMeetingPersistence(), saveChanged: throwSynchronously };
    const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "sync-throw", instanceUrl: "http://localhost", ttlMs: 45000 }) });

    let result: Promise<void> | undefined;
    expect(() => {
      result = persistScheduledMeetingChanges(state.scheduledMeetings, persistence, [dueMeeting]);
    }).not.toThrow();
    return expect(result).rejects.toThrow(/database is locked/);
  });

  it("is logged by the meeting tick, and the tick still advances the meeting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "tick", instanceUrl: "http://localhost", ttlMs: 45000 }) });
    await initScheduledMeetings(state);
    state.scheduledMeetings.byId.set(dueMeeting.id, { ...dueMeeting });
    vi.spyOn(state.scheduledMeetingPersistence!, "saveChanged").mockImplementation(throwSynchronously);

    await expect(runScheduledMeetingTick(state)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Failed to persist scheduled-meeting tick/);
    expect(state.scheduledMeetings.byId.get(dueMeeting.id)?.status).toBe("live");
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
    await new Promise((resolve) => setTimeout(resolve, 60));
    timers.forEach(clearInterval);

    expect(ticks).toBeGreaterThan(2);
    expect(uncaught).toEqual([]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/Throwing tick failed/);
    expect(logged).toMatch(/Rejecting tick failed/);
  });
});
