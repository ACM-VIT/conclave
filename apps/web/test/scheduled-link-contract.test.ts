import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryBackend } from "../../../packages/sfu/server/controlPlane/backends/memory.js";
import { createMeeting, meetingById } from "../../../packages/sfu/server/controlPlane/meetingCommands.js";
import type { CommitResult } from "../../../packages/sfu/server/controlPlane/model.js";
import {
  createHostEventType,
  deleteHostEventType,
  ensureHostProfile,
} from "../../../packages/sfu/server/controlPlane/schedulingCommands.js";
import { controlPlaneStore } from "../../../packages/sfu/server/controlPlane/store.js";
import { registerScheduledMeetingRoutes } from "../../../packages/sfu/server/http/scheduledMeetingRoutes.js";
import { registerSchedulingRoutes } from "../../../packages/sfu/server/http/schedulingRoutes.js";
import { buildSchedulingMeetingLink } from "../../../packages/sfu/server/schedulingLinks.js";
import type { SfuState } from "../../../packages/sfu/server/state.js";
import { fetchPublicScheduledMeeting, isSfuTooOldForBookings } from "../src/lib/scheduled-meeting-lookup";
import { findScheduledMeetingForLink } from "../src/lib/sfu-client-id";

const SECRET = "scheduled-link-test-secret";
const ROOM = "weekly-sync";
const ORIGIN = "https://meet.test";
const HOST = { userId: "host", email: "host@example.com" };
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

const startSfu = async (register: (app: express.Express) => void) => {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const fixtureValue = <T,>(result: CommitResult<T>): T => {
  if (!result.ok) throw new Error(`Could not seed scheduled link fixture: ${result.reason}`);
  return result.value;
};

const currentSfu = async () => {
  const store = controlPlaneStore(createMemoryBackend());
  const origin = await startSfu((app) => {
    const state = { controlPlane: store } as SfuState;
    registerScheduledMeetingRoutes(app, { state, sfuSecret: SECRET });
    registerSchedulingRoutes(app, { state, sfuSecret: SECRET });
  });
  const open = (link: string) => {
    const url = new URL(link);
    return findScheduledMeetingForLink(url.searchParams.get("clientId"), (clientId) =>
      fetchPublicScheduledMeeting(`${origin}/scheduled-meetings`, SECRET, clientId, ROOM),
    );
  };
  const hostRequest = async <T,>(path: string, method = "GET"): Promise<T> => {
    const response = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", "x-sfu-secret": SECRET, "x-user-id": HOST.userId, "x-user-email": HOST.email },
      body: method === "GET" ? undefined : "{}",
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return await response.json() as T;
  };
  return { store, open, hostRequest };
};

const ROWS = (["conclave", "acme"] as const).flatMap((serverDefault) =>
  (["conclave", "acme", "beta"] as const).flatMap((bookedUnder) =>
    (["booking_link", "manual"] as const).map((source) => [serverDefault, bookedUnder, source] as const),
  ),
);

describe("scheduled links against the current SFU", () => {
  it.each(ROWS)(
    "keeps a %s deployment's link to a %s %s meeting in the saved tenant after opening the host dashboard",
    async (serverDefault, bookedUnder, source) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", serverDefault);
      const { store, open, hostRequest } = await currentSfu();
      const booking = fixtureValue(await store.commit(createMeeting(
        { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: ROOM, source },
        { clientId: bookedUnder, createdBy: HOST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
      )));
      const matching = { clientId: bookedUnder, meeting: { id: booking.id, clientId: bookedUnder } };
      const linked = buildSchedulingMeetingLink(ORIGIN, booking);
      const bare = `${ORIGIN}/${ROOM}`;
      const wrong = `${bare}?clientId=unrelated`;
      const bareCanFindBooking = [serverDefault, "conclave"].includes(bookedUnder);
      const expectLinks = async () => {
        expect(await open(linked)).toMatchObject(matching);
        expect(await open(wrong)).toBeNull();
        if (bareCanFindBooking) expect(await open(bare)).toMatchObject(matching);
        else expect(await open(bare)).toBeNull();
      };

      await expectLinks();
      for (const [method, path] of [
        ["GET", "/scheduling/profile"],
        ["PUT", "/scheduling/profile"],
        ["GET", "/scheduling/availability/default"],
        ["GET", "/scheduling/event-types"],
        ["GET", "/scheduling/calendar/google"],
        ["GET", "/scheduling/bookings"],
      ]) await hostRequest(path, method);
      await expectLinks();
      expect(await store.read(meetingById(booking.id))).toEqual(booking);
    },
  );

  it("reports an unsupported service without trying a different endpoint", async () => {
    const requested: string[] = [];
    const origin = await startSfu((app) => {
      app.use((req, res) => {
        requested.push(req.path);
        res.sendStatus(404);
      });
    });
    await expect(findScheduledMeetingForLink("conclave", (clientId) =>
      fetchPublicScheduledMeeting(`${origin}/scheduled-meetings`, SECRET, clientId, ROOM),
    )).rejects.toSatisfy(isSfuTooOldForBookings);
    expect(requested).toEqual([`/scheduled-meetings/public/v2/by-room/${ROOM}`]);
  });
});

describe("a booking whose host profile is now in the deployment namespace", () => {
  it("stays listed and keeps its slot busy after its event type is deleted", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const { store, hostRequest } = await currentSfu();
    const profile = fixtureValue(await store.commit(ensureHostProfile(
      { clientId: "acme", ...HOST, timeZone: "UTC" }, { syncIdentity: false },
    )));
    const retired = fixtureValue(await store.commit(createHostEventType(
      profile.id, { title: "Old intro", slug: "old-intro", isActive: true },
    )));
    const current = fixtureValue(await store.commit(createHostEventType(
      profile.id, { title: "Intro", slug: "intro", isActive: true },
    )));
    const slotsPath = `/scheduling/public/${encodeURIComponent(profile.username)}/${current.slug}/slots`;
    type Slot = { startAt: number; endAt: number };
    const before = await hostRequest<{ slots: Slot[] }>(slotsPath);
    const taken = before.slots[0];
    if (!taken) throw new Error("Expected a slot to book");
    const booking = fixtureValue(await store.commit(createMeeting(
      {
        title: "Old intro", scheduledStartAt: taken.startAt, scheduledEndAt: taken.endAt,
        roomCode: ROOM, source: "booking_link", eventTypeId: retired.id,
      },
      { clientId: "conclave", createdBy: "guest@example.com", defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
    )));
    fixtureValue(await store.commit(deleteHostEventType(profile.id, retired.id)));

    const { bookings } = await hostRequest<{ bookings: Array<{ id: string }> }>("/scheduling/bookings");
    const after = await hostRequest<{ slots: Slot[] }>(slotsPath);
    expect(bookings.map(({ id }) => id)).toEqual([booking.id]);
    expect(after.slots.length).toBeGreaterThan(0);
    expect(after.slots.map(({ startAt }) => startAt)).not.toContain(taken.startAt);
    expect(await store.read(meetingById(booking.id))).toEqual(booking);
  });
});
