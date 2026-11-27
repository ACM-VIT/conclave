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
import { roomIdFromMeetingPath } from "../src/lib/meeting-links";
import { isSfuTooOldForBookings } from "../src/lib/scheduled-meeting-lookup";
import { lookupScheduledMeetingForCode } from "../src/lib/scheduled-meetings";
import { resolveMeetingClientId } from "../src/lib/sfu-client-id";

const SECRET = "scheduled-link-test-secret";
const ROOM = "weekly-sync";
const ORIGIN = "https://meet.test";
const HOST = { userId: "host", email: "host@example.com" };
const servers: Array<{ close: () => void }> = [];

let sfuUrl: string;
vi.mock("@/lib/sfu-user-auth", () => ({ buildScheduledWebinarHeaders: vi.fn() }));
vi.mock("@/lib/sfu-admin-auth", () => ({ resolveSfuSecret: () => SECRET }));
vi.mock("@/lib/sfu-url", () => ({ resolveSfuUrls: () => [sfuUrl] }));
vi.mock("@/app/lib/utils", () => ({ readResponseError: vi.fn() }));

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
  sfuUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return sfuUrl;
};

const open = (link: string) => {
  const url = new URL(link);
  return lookupScheduledMeetingForCode({
    roomCode: roomIdFromMeetingPath(decodeURIComponent(url.pathname.slice(1))),
    clientId: resolveMeetingClientId(url.searchParams.get("clientId")),
  }, { allowLegacyBooking: !url.searchParams.has("clientId") });
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
  const hostRequest = async <T,>(path: string, method = "GET"): Promise<T> => {
    const response = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", "x-sfu-secret": SECRET, "x-user-id": HOST.userId, "x-user-email": HOST.email },
      body: method === "GET" ? undefined : "{}",
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return await response.json() as T;
  };
  return { store, origin, hostRequest };
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
      const { store, hostRequest } = await currentSfu();
      const booking = fixtureValue(await store.commit(createMeeting(
        { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: ROOM, source },
        { clientId: bookedUnder, createdBy: HOST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
      )));
      const matching = { clientId: bookedUnder, meeting: { id: booking.id, clientId: bookedUnder } };
      const linked = buildSchedulingMeetingLink(ORIGIN, booking);
      const bare = `${ORIGIN}/${ROOM}`;
      const wrong = `${bare}?clientId=unrelated`;
      const expectLinks = async () => {
        expect(await open(linked)).toMatchObject({ kind: "scheduled", ...matching });
        expect(await open(wrong)).toEqual({ kind: "unscheduled" });
        if (serverDefault === bookedUnder || (bookedUnder === "conclave" && source === "booking_link")) {
          expect(await open(bare)).toMatchObject({ kind: "scheduled", ...matching });
        }
        else expect(await open(bare)).toEqual({ kind: "unscheduled" });
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

  it("opens the URL emitted by a new booking under its saved tenant", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    vi.stubEnv("SCHEDULING_EMAIL_ENABLED", "0");
    const { store, origin, hostRequest } = await currentSfu();
    const profile = fixtureValue(await store.commit(ensureHostProfile(
      { clientId: "conclave", ...HOST, timeZone: "UTC" }, { syncIdentity: false },
    )));
    const eventType = fixtureValue(await store.commit(createHostEventType(
      profile.id, { title: "Intro", slug: "intro", isActive: true },
    )));
    const page = `/scheduling/public/${encodeURIComponent(profile.username)}/${eventType.slug}`;
    const { slots } = await hostRequest<{ slots: Array<{ startAt: number }> }>(`${page}/slots`);
    const slot = slots[0];
    if (!slot) throw new Error("Expected a slot to book");
    const result = await fetch(origin + page + "/book", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sfu-secret": SECRET, "x-app-origin": ORIGIN, "x-sfu-client": "acme" },
      body: JSON.stringify({ startAt: slot.startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" }),
    });
    expect(result.status).toBe(201);
    const { booking } = await result.json() as { booking: { id: string; roomCode: string; meetingLink: string } };
    const found = await open(booking.meetingLink);
    expect(found).toMatchObject({
      kind: "scheduled", sfuUrl: origin, clientId: "conclave",
      meeting: { id: booking.id, roomCode: booking.roomCode, clientId: "conclave" },
    });
    expect(found).not.toHaveProperty("meeting.attendeeEmail");
    const bare = `${ORIGIN}/${booking.roomCode}`;
    expect(await open(bare)).toEqual(found);
    expect(await open(bare + "?clientId=acme")).toEqual({ kind: "unscheduled" });
    expect(await open(bare + "?clientId=")).toEqual({ kind: "unscheduled" });
    const distinct = fixtureValue(await store.commit(createMeeting(
      { title: "Separate meeting", scheduledStartAt: Date.now() + 60_000, roomCode: booking.roomCode },
      { clientId: "acme", createdBy: HOST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
    )));
    expect(await open(bare)).toMatchObject({ kind: "scheduled", clientId: "acme", meeting: { id: distinct.id } });
    expect(await open(booking.meetingLink)).toEqual(found);
  });

  it("does not try the legacy alias when the default lookup is inconclusive", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    const tenants: unknown[] = [];
    await startSfu((app) => {
      app.get("/scheduled-meetings/public/v2/by-room/:roomCode", (req, res) => {
        tenants.push(req.query.clientId);
        res.sendStatus(503);
      });
    });
    expect(await open(`${ORIGIN}/${ROOM}`)).toEqual({ kind: "unknown" });
    expect(tenants).toEqual(["acme"]);
  });

  it("reports an unsupported service without trying a different endpoint", async () => {
    const requested: string[] = [];
    await startSfu((app) => {
      app.use((req, res) => {
        requested.push(req.path);
        res.sendStatus(404);
      });
    });
    await expect(open(`${ORIGIN}/${ROOM}?clientId=conclave`)).rejects.toSatisfy(isSfuTooOldForBookings);
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
