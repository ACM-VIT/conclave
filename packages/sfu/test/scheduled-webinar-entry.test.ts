import { describe, expect, it } from "vitest";
import type { ScheduledWebinar } from "../types.js";
import {
  createScheduledWebinarStore,
  resolveScheduledWebinarAttendeeEntry,
  type ScheduledWebinarStore,
} from "../server/scheduledWebinars.js";

const START_AT = Date.UTC(2026, 6, 11, 12);

const scheduledWebinar = (
  overrides: Partial<ScheduledWebinar> = {},
): ScheduledWebinar => ({
  id: "webinar-1",
  clientId: "conclave",
  roomId: "sched-room-1",
  linkSlug: "early-entry",
  title: "Early entry",
  description: "",
  hostEmail: "host@example.com",
  hostName: "Host",
  hostUserId: null,
  coHosts: [],
  scheduledStartAt: START_AT,
  scheduledEndAt: START_AT + 60 * 60 * 1000,
  status: "scheduled",
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
  liveStartedAt: null,
  endedAt: null,
  totalJoinCount: 0,
  peakAttendeeCount: 0,
  webinarLink: "http://localhost:3000/w/early-entry",
  coHostInviteTokenHash: null,
  coHostInviteTokenCreatedAt: null,
  ...overrides,
});

const storeWith = (webinar: ScheduledWebinar): ScheduledWebinarStore => {
  const store = createScheduledWebinarStore();
  store.byId.set(webinar.id, webinar);
  store.bySlug.set(webinar.linkSlug, webinar.id);
  store.byRoomChannel.set(
    `${webinar.clientId}:${webinar.roomId}`,
    webinar.id,
  );
  return store;
};

describe("scheduled webinar attendee entry", () => {
  it("opens the public slug at the configured early-entry time", () => {
    const webinar = scheduledWebinar();
    const store = storeWith(webinar);

    expect(
      resolveScheduledWebinarAttendeeEntry(
        store,
        webinar.linkSlug,
        webinar.clientId,
        START_AT - 10 * 60 * 1000,
      ),
    ).toEqual({ kind: "open", webinar });
  });

  it("keeps a known scheduled slug closed before early entry", () => {
    const webinar = scheduledWebinar();
    const store = storeWith(webinar);

    expect(
      resolveScheduledWebinarAttendeeEntry(
        store,
        webinar.linkSlug,
        webinar.clientId,
        START_AT - 10 * 60 * 1000 - 1,
      ),
    ).toEqual({ kind: "closed", webinar });
  });

  it("opens a manually started webinar before its scheduled entry time", () => {
    const webinar = scheduledWebinar({ status: "live" });
    const store = storeWith(webinar);

    expect(
      resolveScheduledWebinarAttendeeEntry(
        store,
        webinar.linkSlug,
        webinar.clientId,
        START_AT - 60 * 60 * 1000,
      ),
    ).toEqual({ kind: "open", webinar });
  });

  it("leaves instant webinar links to the existing link policy", () => {
    expect(
      resolveScheduledWebinarAttendeeEntry(
        createScheduledWebinarStore(),
        "instant-link",
        "conclave",
        START_AT,
      ),
    ).toEqual({ kind: "unscheduled", webinar: null });
  });

  it.each(["ended", "cancelled"] as const)(
    "rejects a webinar whose status is %s",
    (status) => {
      const webinar = scheduledWebinar({ status });
      const store = storeWith(webinar);

      expect(
        resolveScheduledWebinarAttendeeEntry(
          store,
          webinar.linkSlug,
          webinar.clientId,
          START_AT,
        ),
      ).toEqual({ kind: "closed", webinar });
    },
  );
});
