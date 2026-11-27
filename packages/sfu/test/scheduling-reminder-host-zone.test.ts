import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryBackend } from "../server/controlPlane/backends/memory.js";
import { createMeeting, meetingById } from "../server/controlPlane/meetingCommands.js";
import { createHostEventType, deleteHostEventType, ensureHostProfile } from "../server/controlPlane/schedulingCommands.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { sendDueSchedulingEmailReminders } from "../server/schedulingEmailReminders.js";
import type { SfuState } from "../server/state.js";

const HOST = { userId: "host", email: "host@example.com", name: "Ada Host" };
const GUEST = { name: "Grace Guest", email: "guest@example.com", timeZone: "Asia/Kolkata" };
const STARTS_AT = Date.UTC(2031, 6, 1, 14);
const TWENTY_MINUTES_BEFORE = STARTS_AT - 20 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type SentMessage = { to: { email: string }; text: string };

const sendReminders = async (state: SfuState): Promise<SentMessage[]> => {
  const sent: SentMessage[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(...(JSON.parse(String(init?.body)) as { messages: SentMessage[] }).messages);
    return new Response("{}", { status: 200 });
  });
  await sendDueSchedulingEmailReminders(state);
  return sent;
};

const TENANT_ROWS = [
  ["conclave", "acme", "the profile is now under the deployment default"],
  ["conclave", "conclave", "the host's profile is in the booking's tenant"],
  ["acme", "acme", "the booking was made in the default tenant"],
] as const;

describe("a booking reminder shows the host their own time zone", () => {
  it.each(TENANT_ROWS)(
    "for a booking in %s with default tenant %s whose event type was deleted (%s)",
    async (bookedUnder, serverDefault) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", "https://mail.test");
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "mail-secret");
      let now = STARTS_AT - 60 * 60 * 1000;
      const controlPlane = controlPlaneStore(createMemoryBackend(), () => now);
      const state = { controlPlane } as SfuState;
      const profile = await controlPlane.commit(ensureHostProfile({
        clientId: serverDefault, ...HOST, timeZone: "America/New_York",
      }, { syncIdentity: false }));
      if (!profile.ok) throw new Error("Could not create host profile");
      const retired = await controlPlane.commit(createHostEventType(profile.value.id, {
        title: "Old intro", slug: "old-intro", isActive: true,
      }));
      if (!retired.ok) throw new Error("Could not create event type");
      const booking = await controlPlane.commit(createMeeting({
        title: "Old intro",
        scheduledStartAt: STARTS_AT,
        roomCode: "old-intro-call",
        source: "booking_link",
        eventTypeId: retired.value.id,
        attendeeName: GUEST.name,
        attendeeEmail: GUEST.email,
        attendeeTimeZone: GUEST.timeZone,
      }, {
        clientId: bookedUnder, createdBy: GUEST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId,
      }));
      if (!booking.ok) throw new Error("Could not create meeting");
      expect((await controlPlane.commit(deleteHostEventType(profile.value.id, retired.value.id))).ok).toBe(true);
      const host = await controlPlane.commit(ensureHostProfile({
        clientId: serverDefault, ...HOST,
      }, { syncIdentity: false }));
      expect(host).toMatchObject({ ok: true, value: { id: profile.value.id } });
      expect((await controlPlane.read(meetingById(booking.value.id)))?.clientId).toBe(bookedUnder);

      now = TWENTY_MINUTES_BEFORE;
      const sent = await sendReminders(state);

      const toHost = sent.find((message) => message.to.email === HOST.email);
      const toGuest = sent.find((message) => message.to.email === GUEST.email);
      expect(toHost?.text).toMatch(/10:00\sAM/);
      expect(toHost?.text).not.toMatch(/7:30\sPM/);
      expect(toGuest?.text).toMatch(/7:30\sPM/);
    },
  );
});
