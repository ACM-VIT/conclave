import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSchedulingRoutes } from "../server/http/schedulingRoutes.js";
import {
  createScheduledMeeting,
  createScheduledMeetingStore,
  getScheduledMeetingById,
} from "../server/scheduledMeetings.js";
import {
  createEventType,
  createSchedulingStore,
  deleteEventType,
  ensureSchedulingProfile,
  getProfileByUser,
} from "../server/scheduling.js";
import { sendDueSchedulingEmailReminders } from "../server/schedulingEmailReminders.js";
import type { SfuState } from "../server/state.js";

const SECRET = "reminder-zone-secret-0123456789";
const HOST = { userId: "host", email: "host@example.com", name: "Ada Host" };
const GUEST = { name: "Grace Guest", email: "guest@example.com", timeZone: "Asia/Kolkata" };
const STARTS_AT = Date.UTC(2031, 6, 1, 14);
const TWENTY_MINUTES_BEFORE = STARTS_AT - 20 * 60 * 1000;
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type SentMessage = { to: { email: string }; text: string };

const hostOpensScheduling = async (state: SfuState) => {
  const app = express();
  app.use(express.json());
  registerSchedulingRoutes(app, { state, sfuSecret: SECRET });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/scheduling/profile`, {
    headers: { "x-sfu-secret": SECRET, "x-user-id": HOST.userId, "x-user-email": HOST.email },
  });
  expect(response.status).toBe(200);
};

const sendReminders = async (state: SfuState): Promise<SentMessage[]> => {
  const sent: SentMessage[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(...(JSON.parse(String(init?.body)) as { messages: SentMessage[] }).messages);
    return new Response("{}", { status: 200 });
  });
  await sendDueSchedulingEmailReminders(state, TWENTY_MINUTES_BEFORE);
  return sent;
};

const TENANT_ROWS = [
  ["conclave", "acme", "the host's profile moved to the new default tenant"],
  ["conclave", "conclave", "the host's profile stayed in the booking's tenant"],
  ["acme", "acme", "the booking was made in the default tenant"],
] as const;

describe("a booking reminder shows the host their own time zone", () => {
  it.each(TENANT_ROWS)(
    "for a booking in %s with default tenant %s whose event type was deleted (%s)",
    async (bookedUnder, serverDefault) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", "https://mail.test");
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "mail-secret");
      const state = {
        scheduledMeetings: createScheduledMeetingStore(),
        scheduling: createSchedulingStore(),
      } as unknown as SfuState;
      const profile = ensureSchedulingProfile(state.scheduling, {
        clientId: bookedUnder,
        ...HOST,
        timeZone: "America/New_York",
      });
      const retired = createEventType(state.scheduling, profile, { title: "Old intro", slug: "old-intro", isActive: true });
      const booking = createScheduledMeeting(
        state.scheduledMeetings,
        {
          title: "Old intro",
          scheduledStartAt: STARTS_AT,
          roomCode: "old-intro-call",
          source: "booking_link",
          eventTypeId: retired.id,
          attendeeName: GUEST.name,
          attendeeEmail: GUEST.email,
          attendeeTimeZone: GUEST.timeZone,
        },
        { clientId: bookedUnder, createdBy: GUEST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
      );
      deleteEventType(state.scheduling, profile, retired.id);
      await hostOpensScheduling(state);
      expect(getProfileByUser(state.scheduling, serverDefault, HOST.userId)?.id).toBe(profile.id);
      expect(getScheduledMeetingById(state.scheduledMeetings, booking.id)?.clientId).toBe(bookedUnder);

      const sent = await sendReminders(state);

      const toHost = sent.find((message) => message.to.email === HOST.email);
      const toGuest = sent.find((message) => message.to.email === GUEST.email);
      expect(toHost?.text).toMatch(/10:00\sAM/);
      expect(toHost?.text).not.toMatch(/7:30\sPM/);
      expect(toGuest?.text).toMatch(/7:30\sPM/);
    },
  );
});
