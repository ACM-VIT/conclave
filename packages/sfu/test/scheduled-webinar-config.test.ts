import { describe, expect, it } from "vitest";
import type { ScheduledWebinar } from "../types.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { publishWebinar, seedRoomConfig } from "./fixtures/webinar-room.js";
import { createSfuState } from "../server/state.js";

const START_AT = Date.UTC(2026, 6, 11, 12);

const scheduledWebinar = (
  overrides: Partial<ScheduledWebinar> = {},
): ScheduledWebinar => ({
  id: "webinar-1",
  clientId: "conclave",
  roomId: "sched-room-1",
  linkSlug: "config-sync",
  title: "Config sync",
  description: "",
  hostEmail: "host@example.com",
  hostName: "Host",
  hostUserId: null,
  coHosts: [],
  scheduledStartAt: START_AT,
  scheduledEndAt: START_AT + 60 * 60 * 1000,
  status: "live",
  publicAccess: true,
  maxAttendees: 500,
  requiresInviteCode: false,
  waitingRoomEnabled: true,
  earlyEntryMinutes: 10,
  qaEnabled: true,
  notes: "",
  createdAt: START_AT - 60 * 60 * 1000,
  createdBy: "host@example.com",
  updatedAt: START_AT - 60 * 60 * 1000,
  liveStartedAt: START_AT,
  endedAt: null,
  totalJoinCount: 0,
  peakAttendeeCount: 0,
  webinarLink: "http://localhost:3000/w/config-sync",
  coHostInviteTokenHash: null,
  coHostInviteTokenCreatedAt: null,
  ...overrides,
});

const makeState = () => createSfuState({
  roomRegistry: new LocalRoomRegistry({
    instanceId: "webinar-config-test",
    instanceUrl: "http://localhost",
    ttlMs: 45000,
  }),
});

describe("scheduled webinar room config", async () => {
  it("seeds an open room from the schedule the first time", async () => {
    const state = makeState();
    const config = await publishWebinar(state, scheduledWebinar());
    expect(config).toMatchObject({
      enabled: true,
      locked: false,
      publicAccess: true,
      maxAttendees: 500,
      waitingRoomEnabled: true,
      qaEnabled: true,
      scheduledWebinarId: "webinar-1",
    });
  });

  it("keeps the host's live changes when the schedule is re-applied unchanged", async () => {
    const state = makeState();
    const webinar = scheduledWebinar();
    const config = await publishWebinar(state, webinar);
    // The host locks the webinar, turns Q&A off and lowers the cap.
    config.locked = true;
    config.qaEnabled = false;
    config.maxAttendees = 50;
    config.publicAccess = false;

    // A panelist joins (or the scheduler ticks): the same revision is re-applied.
    await seedRoomConfig(state, webinar);
    expect(config).toMatchObject({
      enabled: true,
      locked: true,
      qaEnabled: false,
      maxAttendees: 50,
      publicAccess: false,
    });
  });

  it("copies a value again when the schedule itself changes it", async () => {
    const state = makeState();
    const webinar = scheduledWebinar();
    const config = await publishWebinar(state, webinar);
    config.locked = true;
    config.maxAttendees = 50;

    webinar.maxAttendees = 800;
    await publishWebinar(state, webinar);
    expect(config.maxAttendees).toBe(800);
    expect(config.locked).toBe(true);
  });

  it("locks the room when the schedule ends and reopens it if the schedule is reopened", async () => {
    const state = makeState();
    const webinar = scheduledWebinar();
    const config = await publishWebinar(state, webinar);

    webinar.status = "ended";
    await publishWebinar(state, webinar);
    expect(config).toMatchObject({ enabled: true, locked: true });

    webinar.status = "live";
    await publishWebinar(state, webinar);
    expect(config).toMatchObject({ enabled: true, locked: false });
  });

  it("disables and locks the room for a cancelled schedule", async () => {
    const state = makeState();
    const webinar = scheduledWebinar();
    const config = await publishWebinar(state, webinar);

    webinar.status = "cancelled";
    await publishWebinar(state, webinar);
    expect(config).toMatchObject({ enabled: false, locked: true });
  });

  it("keeps a host's unlock of an ended room when the schedule is re-applied unchanged", async () => {
    const state = makeState();
    const webinar = scheduledWebinar({ status: "ended" });
    const config = await publishWebinar(state, webinar);
    config.locked = false;

    await seedRoomConfig(state, webinar);
    expect(config.locked).toBe(false);

    webinar.status = "cancelled";
    await publishWebinar(state, webinar);
    expect(config).toMatchObject({ enabled: false, locked: true });
  });

  it("never opens a room for a schedule that is already ended", async () => {
    const state = makeState();
    const config = await publishWebinar(state, scheduledWebinar({ status: "ended" }));
    expect(config.enabled).toBe(false);
    expect(config.locked).toBe(true);
  });
});
