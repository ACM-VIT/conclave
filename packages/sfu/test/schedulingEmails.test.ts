import { afterEach, describe, expect, it } from "vitest";
import type {
  ScheduledMeeting,
  SchedulingEventType,
  SchedulingProfile,
} from "../types.js";
import {
  buildSchedulingBookingEmailMessages,
  buildSchedulingReminderEmailMessages,
  resolveSchedulingEmailConfig,
  sendSchedulingBookingEmails,
} from "../server/schedulingEmails.js";
import { shouldSendSchedulingReminder } from "../server/schedulingEmailReminders.js";

const originalEnv = {
  SCHEDULING_EMAIL_ENABLED: process.env.SCHEDULING_EMAIL_ENABLED,
  SCHEDULING_EMAIL_WORKER_URL: process.env.SCHEDULING_EMAIL_WORKER_URL,
  SCHEDULING_EMAIL_WORKER_SECRET: process.env.SCHEDULING_EMAIL_WORKER_SECRET,
  CLOUDFLARE_EMAIL_WORKER_URL: process.env.CLOUDFLARE_EMAIL_WORKER_URL,
  CLOUDFLARE_EMAIL_WORKER_SECRET: process.env.CLOUDFLARE_EMAIL_WORKER_SECRET,
  SCHEDULING_EMAIL_REMINDERS_ENABLED:
    process.env.SCHEDULING_EMAIL_REMINDERS_ENABLED,
  SCHEDULING_EMAIL_REMINDER_MINUTES:
    process.env.SCHEDULING_EMAIL_REMINDER_MINUTES,
};

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const profile = (): SchedulingProfile => ({
  id: "profile-1",
  clientId: "default",
  userId: "user-1",
  email: "host@example.com",
  name: "Ada Host",
  username: "ada",
  timeZone: "America/New_York",
  createdAt: 0,
  updatedAt: 0,
});

const eventType = (): SchedulingEventType => ({
  id: "event-1",
  clientId: "default",
  profileId: "profile-1",
  userId: "user-1",
  slug: "intro",
  title: "Intro Call",
  description: "",
  durationMinutes: 30,
  minimumNoticeMinutes: 120,
  bookingWindowDays: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  isActive: true,
  requiresCalendar: false,
  createdAt: 0,
  updatedAt: 0,
});

const meeting = (): ScheduledMeeting => ({
  id: "meeting-1",
  clientId: "default",
  roomCode: "intro-1234",
  title: "Intro Call",
  hostEmail: "host@example.com",
  hostName: "Ada Host",
  hostUserId: "user-1",
  scheduledStartAt: Date.UTC(2026, 6, 1, 14),
  scheduledEndAt: Date.UTC(2026, 6, 1, 14, 30),
  status: "scheduled",
  startedAt: null,
  endedAt: null,
  createdAt: Date.UTC(2026, 5, 30),
  createdBy: "guest@example.com",
  updatedAt: Date.UTC(2026, 5, 30),
  source: "booking_link",
  eventTypeId: "event-1",
  attendeeName: "Grace Guest",
  attendeeEmail: "guest@example.com",
  attendeeNote: "Looking forward to it.",
  attendeeTimeZone: "Asia/Kolkata",
  googleCalendarEventId: null,
  calendarSyncStatus: "not_required",
  calendarSyncError: null,
  emailNotificationStatus: "pending",
  emailNotificationError: null,
  emailNotificationSentAt: null,
});

afterEach(() => {
  restoreEnv();
});

describe("scheduling email notifications", () => {
  it("builds attendee and host booking confirmation messages with calendar attachments", async () => {
    const messages = await buildSchedulingBookingEmailMessages({
      profile: profile(),
      eventType: eventType(),
      meeting: meeting(),
      appOrigin: "https://conclave.test",
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.to.email)).toEqual([
      "guest@example.com",
      "host@example.com",
    ]);
    expect(messages[0]?.subject).toContain("You're booked");
    expect(messages[0]?.text).toContain("https://conclave.test/intro-1234");
    expect(messages[0]?.text).not.toContain("clientId=default");
    expect(messages[0]?.html).toContain("Conclave");
    expect(messages[0]?.html).toContain("is confirmed");
    expect(messages[0]?.attachments?.[0]?.filename).toBe("conclave-booking.ics");
    expect(messages[0]?.attachments?.[0]?.content).toContain("BEGIN:VCALENDAR");
    expect(messages[0]?.attachments?.[0]?.content).toContain(
      "ATTENDEE;CN=\"Grace Guest\"",
    );
  });

  it("builds reminder messages without repeating calendar attachments", async () => {
    const messages = await buildSchedulingReminderEmailMessages({
      profile: profile(),
      eventType: eventType(),
      meeting: meeting(),
      appOrigin: "https://conclave.test",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.subject).toBe("Reminder: Intro Call starts soon");
    expect(messages[0]?.html).toContain("starts soon");
    expect(messages[0]?.attachments).toBeUndefined();
    expect(messages[1]?.headers?.["X-Conclave-Email-Type"]).toBe(
      "booking-host-reminder",
    );
  });

  it("sends one reminder inside the reminder window for non-short-notice bookings", () => {
    const booked = meeting();
    const leadMs = 30 * 60 * 1000;

    expect(
      shouldSendSchedulingReminder(
        booked,
        booked.scheduledStartAt - 29 * 60 * 1000,
        leadMs,
      ),
    ).toBe(true);

    expect(
      shouldSendSchedulingReminder(
        { ...booked, emailReminderStatus: "sent" },
        booked.scheduledStartAt - 29 * 60 * 1000,
        leadMs,
      ),
    ).toBe(false);

    expect(
      shouldSendSchedulingReminder(
        {
          ...booked,
          createdAt: booked.scheduledStartAt - 10 * 60 * 1000,
        },
        booked.scheduledStartAt - 9 * 60 * 1000,
        leadMs,
      ),
    ).toBe(false);
  });

  it("does not call a worker when scheduling email is not configured", async () => {
    delete process.env.SCHEDULING_EMAIL_WORKER_URL;
    delete process.env.SCHEDULING_EMAIL_WORKER_SECRET;
    delete process.env.CLOUDFLARE_EMAIL_WORKER_URL;
    delete process.env.CLOUDFLARE_EMAIL_WORKER_SECRET;

    expect(resolveSchedulingEmailConfig()).toBeNull();
    await expect(
      sendSchedulingBookingEmails({
        profile: profile(),
        eventType: eventType(),
        meeting: meeting(),
        appOrigin: "https://conclave.test",
      }),
    ).resolves.toEqual({
      status: "not_configured",
      error: null,
      sentAt: null,
    });
  });
});
