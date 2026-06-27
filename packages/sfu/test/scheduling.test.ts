import { describe, expect, it } from "vitest";
import type { SchedulingEventType, WeeklyAvailability } from "../types.js";
import {
  createEventType,
  createSchedulingStore,
  ensureSchedulingProfile,
  generateAvailableSlots,
  isValidSchedulingSlug,
  zonedTimeToUtc,
} from "../server/scheduling.js";

const eventType = (
  overrides: Partial<SchedulingEventType> = {},
): SchedulingEventType => ({
  id: "event-1",
  clientId: "default",
  profileId: "profile-1",
  userId: "user-1",
  slug: "intro",
  title: "Intro",
  description: "",
  durationMinutes: 30,
  minimumNoticeMinutes: 0,
  bookingWindowDays: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  isActive: true,
  requiresCalendar: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const availability = (
  timeZone: string,
  windows: WeeklyAvailability["windows"],
): WeeklyAvailability => ({
  timeZone,
  windows,
  overrides: [],
});

describe("scheduling", () => {
  it("validates Cal-style event slugs", () => {
    expect(isValidSchedulingSlug("30-min-intro")).toBe(true);
    expect(isValidSchedulingSlug("office-hours")).toBe(true);
    expect(isValidSchedulingSlug("-intro")).toBe(false);
    expect(isValidSchedulingSlug("intro-")).toBe(false);
    expect(isValidSchedulingSlug("Intro")).toBe(false);
  });

  it("does not require a calendar for new event types by default", () => {
    const store = createSchedulingStore();
    const profile = ensureSchedulingProfile(store, {
      clientId: "default",
      userId: "user-1",
      email: "host@example.com",
      name: "Host",
      timeZone: "UTC",
    });
    const created = createEventType(store, profile, {
      title: "Office hours",
      isActive: true,
    });

    expect(created.isActive).toBe(true);
    expect(created.requiresCalendar).toBe(false);
  });

  it("generates slots from weekly availability", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("UTC", [
        { day: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      ]),
      busyIntervals: [],
      from: Date.UTC(2026, 0, 5, 0),
      to: Date.UTC(2026, 0, 5, 12),
      now: Date.UTC(2026, 0, 4, 0),
    });

    expect(slots.map((slot) => slot.startAt)).toEqual([
      Date.UTC(2026, 0, 5, 9),
      Date.UTC(2026, 0, 5, 9, 30),
    ]);
  });

  it("removes slots that overlap internal or Google busy intervals", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("UTC", [
        { day: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      ]),
      busyIntervals: [
        {
          startAt: Date.UTC(2026, 0, 5, 9, 15),
          endAt: Date.UTC(2026, 0, 5, 9, 45),
        },
      ],
      from: Date.UTC(2026, 0, 5, 0),
      to: Date.UTC(2026, 0, 5, 12),
      now: Date.UTC(2026, 0, 4, 0),
    });

    expect(slots).toEqual([]);
  });

  it("honors minimum notice and booking window", () => {
    const slots = generateAvailableSlots({
      eventType: eventType({
        minimumNoticeMinutes: 120,
        bookingWindowDays: 1,
      }),
      availability: availability("UTC", [
        { day: 1, startMinutes: 9 * 60, endMinutes: 12 * 60 },
        { day: 2, startMinutes: 9 * 60, endMinutes: 12 * 60 },
      ]),
      busyIntervals: [],
      from: Date.UTC(2026, 0, 5, 0),
      to: Date.UTC(2026, 0, 7, 0),
      now: Date.UTC(2026, 0, 5, 8),
    });

    expect(slots.map((slot) => slot.startAt)).toEqual([
      Date.UTC(2026, 0, 5, 10),
      Date.UTC(2026, 0, 5, 10, 30),
      Date.UTC(2026, 0, 5, 11),
      Date.UTC(2026, 0, 5, 11, 30),
    ]);
  });

  it("interprets weekly hours in the host timezone after DST changes", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("America/New_York", [
        { day: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      ]),
      busyIntervals: [],
      from: Date.UTC(2026, 2, 9, 0),
      to: Date.UTC(2026, 2, 10, 0),
      now: Date.UTC(2026, 2, 8, 0),
    });

    expect(slots[0]?.startAt).toBe(Date.UTC(2026, 2, 9, 13));
  });

  it("converts local wall-clock times without double-applying DST offsets", () => {
    expect(zonedTimeToUtc("2026-01-05", 9 * 60, "America/New_York")).toBe(
      Date.UTC(2026, 0, 5, 14),
    );
    expect(zonedTimeToUtc("2026-03-09", 9 * 60, "America/New_York")).toBe(
      Date.UTC(2026, 2, 9, 13),
    );
  });

  it("rejects nonexistent wall-clock times during spring-forward gaps", () => {
    expect(
      Number.isNaN(zonedTimeToUtc("2026-03-08", 2 * 60 + 30, "America/New_York")),
    ).toBe(true);
    expect(zonedTimeToUtc("2026-03-08", 3 * 60 + 30, "America/New_York")).toBe(
      Date.UTC(2026, 2, 8, 7, 30),
    );
  });

  it("skips availability windows that start inside a spring-forward gap", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("America/New_York", [
        { day: 0, startMinutes: 2 * 60 + 30, endMinutes: 3 * 60 + 30 },
      ]),
      busyIntervals: [],
      from: Date.UTC(2026, 2, 8, 0),
      to: Date.UTC(2026, 2, 9, 0),
      now: Date.UTC(2026, 2, 7, 0),
    });

    expect(slots).toEqual([]);
  });

  it("uses the later occurrence for repeated fall-back wall times", () => {
    expect(zonedTimeToUtc("2026-11-01", 1 * 60 + 30, "America/New_York")).toBe(
      Date.UTC(2026, 10, 1, 6, 30),
    );
  });

  it("does not expand availability across a fall-back fold", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("America/New_York", [
        { day: 0, startMinutes: 1 * 60, endMinutes: 2 * 60 },
      ]),
      busyIntervals: [],
      from: Date.UTC(2026, 10, 1, 0),
      to: Date.UTC(2026, 10, 2, 0),
      now: Date.UTC(2026, 9, 31, 0),
    });

    expect(slots.map((slot) => slot.startAt)).toEqual([
      Date.UTC(2026, 10, 1, 6),
      Date.UTC(2026, 10, 1, 6, 30),
    ]);
  });

  it("removes slots that fall inside a previous booking after-buffer", () => {
    const slots = generateAvailableSlots({
      eventType: eventType(),
      availability: availability("UTC", [
        { day: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      ]),
      busyIntervals: [
        {
          startAt: Date.UTC(2026, 0, 5, 9),
          endAt: Date.UTC(2026, 0, 5, 9, 45),
        },
      ],
      from: Date.UTC(2026, 0, 5, 0),
      to: Date.UTC(2026, 0, 5, 12),
      now: Date.UTC(2026, 0, 4, 0),
    });

    expect(slots).toEqual([]);
  });
});
