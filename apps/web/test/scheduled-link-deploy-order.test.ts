import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScheduledMeetingRoutes } from "../../../packages/sfu/server/http/scheduledMeetingRoutes.js";
import {
  createScheduledMeeting,
  createScheduledMeetingStore,
  getScheduledMeetingById,
} from "../../../packages/sfu/server/scheduledMeetings.js";
import { registerSchedulingRoutes } from "../../../packages/sfu/server/http/schedulingRoutes.js";
import {
  createEventType,
  createSchedulingStore,
  deleteEventType,
  ensureSchedulingProfile,
  getProfileByUser,
} from "../../../packages/sfu/server/scheduling.js";
import { buildSchedulingMeetingLink } from "../../../packages/sfu/server/schedulingLinks.js";
import type { SfuState } from "../../../packages/sfu/server/state.js";
import { registerScheduledMeetingRoutes as registerStagingScheduledMeetingRoutes } from "./staging-sfu/scheduledMeetingRoutes.js";
import { registerSchedulingRoutes as registerStagingSchedulingRoutes } from "./staging-sfu/schedulingRoutes.js";
import { buildSchedulingMeetingLink as buildStagingSchedulingMeetingLink } from "./staging-sfu/schedulingLinks.js";
import { stagingLookupScheduledMeetingCandidate, stagingPublicLookup } from "./staging-sfu/webScheduledLink.js";
import { canonicalizeSfuClientId, findScheduledMeetingForLink, resolveBrowserSfuClientId } from "../src/lib/sfu-client-id";
import { fetchPublicScheduledMeeting, isSfuTooOldForBookings } from "../src/lib/scheduled-meeting-lookup";

const SECRET = "deploy-order-secret-0123456789";
const ROOM = "weekly-sync";
const ORIGIN = "https://meet.test";
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

type Sfu = "staging" | "this branch";
type Web = "staging" | "this branch";
type Outcome = string;

type World = {
  store: ReturnType<typeof createScheduledMeetingStore>;
  scheduling: ReturnType<typeof createSchedulingStore>;
};

const HOST = { userId: "host", email: "host@example.com" };

const startSfu = async (sfu: Sfu, world: World) => {
  const app = express();
  app.use(express.json());
  const state = { scheduledMeetings: world.store, scheduling: world.scheduling } as unknown as SfuState;
  const registerMeetings = sfu === "staging" ? registerStagingScheduledMeetingRoutes : registerScheduledMeetingRoutes;
  const registerScheduling = sfu === "staging" ? registerStagingSchedulingRoutes : registerSchedulingRoutes;
  registerMeetings(app, { state, sfuSecret: SECRET });
  registerScheduling(app, { state, sfuSecret: SECRET });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const HOST_ROUTES = [
  ["GET", "/scheduling/profile"],
  ["PUT", "/scheduling/profile"],
  ["GET", "/scheduling/availability/default"],
  ["GET", "/scheduling/event-types"],
  ["GET", "/scheduling/calendar/google"],
  ["GET", "/scheduling/bookings"],
] as const;

const hostRequest = async (origin: string, method: string, path: string) => {
  const response = await fetch(origin + path, {
    method,
    headers: { "content-type": "application/json", "x-sfu-secret": SECRET, "x-user-id": HOST.userId, "x-user-email": HOST.email },
    body: method === "GET" ? undefined : "{}",
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

const hostOpensScheduling = async (origin: string) => {
  for (const [method, path] of HOST_ROUTES) await hostRequest(origin, method, path);
};

const open = async (web: Web, base: string, link: string): Promise<Outcome> => {
  const linked = new URL(link).searchParams.get("clientId") ?? undefined;
  const roomTenant = (clientId: string | undefined) => canonicalizeSfuClientId(clientId) || resolveBrowserSfuClientId();
  if (web === "staging") {
    const found = await stagingLookupScheduledMeetingCandidate(stagingPublicLookup(base, SECRET), ROOM, linked);
    return found ? `booking ${found.meeting.id} in ${roomTenant(found.clientId)}` : `no booking, room in ${roomTenant(linked)}`;
  }
  try {
    const found = await findScheduledMeetingForLink(linked, (clientId) =>
      fetchPublicScheduledMeeting(base, SECRET, clientId, ROOM),
    );
    return found ? `booking ${found.meeting.id} in ${roomTenant(found.clientId)}` : `no booking, room in ${roomTenant(linked)}`;
  } catch (error) {
    if (isSfuTooOldForBookings(error)) return "refused: the meeting service must be updated first";
    throw error;
  }
};

const ROWS = (["conclave", "acme"] as const).flatMap((serverDefault) =>
  (["conclave", "acme", "beta"] as const).flatMap((bookedUnder) =>
    (["booking_link", "manual"] as const).map((source) => [serverDefault, bookedUnder, source] as const),
  ),
);

const hostWithBooking = (bookedUnder: string, source: "booking_link" | "manual") => {
  const world: World = { store: createScheduledMeetingStore(), scheduling: createSchedulingStore() };
  const profile = ensureSchedulingProfile(world.scheduling, { clientId: bookedUnder, ...HOST });
  const eventType = createEventType(world.scheduling, profile, { title: "Intro", slug: "intro", isActive: true });
  const booking = createScheduledMeeting(
    world.store,
    {
      title: "Weekly sync",
      scheduledStartAt: Date.now() + 60_000,
      roomCode: ROOM,
      source,
      eventTypeId: source === "booking_link" ? eventType.id : undefined,
    },
    { clientId: bookedUnder, createdBy: HOST.email, defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
  );
  return { world, booking };
};

describe("a scheduled link opens one booking whichever side deploys first", () => {
  it.each(ROWS)(
    "deploying the SFU first with default %s and a %s booking from %s keeps every link on one booking, and no host scheduling route moves it after the SFU deploy",
    async (serverDefault, bookedUnder, source) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", serverDefault);
      for (const firstOpenedOn of ["staging", "after the SFU deploy"] as const) {
        const { world, booking } = hostWithBooking(bookedUnder, source);
        const bare = `${ORIGIN}/${ROOM}`;
        const stagingEmail = buildStagingSchedulingMeetingLink(ORIGIN, booking);
        const outcomes = new Map<string, Set<Outcome>>();
        const record = (link: string, outcome: Outcome) => {
          const seen = outcomes.get(link) ?? new Set<Outcome>();
          seen.add(outcome);
          outcomes.set(link, seen);
        };

        if (firstOpenedOn === "staging") {
          const stagingSfu = await startSfu("staging", world);
          await hostOpensScheduling(stagingSfu);
          for (const link of [bare, stagingEmail]) record(link, await open("staging", `${stagingSfu}/scheduled-meetings`, link));
        }

        const storedBeforeDeploy = getScheduledMeetingById(world.store, booking.id)?.clientId;
        const newSfu = await startSfu("this branch", world);
        const branchEmail = buildSchedulingMeetingLink(ORIGIN, getScheduledMeetingById(world.store, booking.id) ?? booking);
        const openEverywhere = async () => {
          for (const web of ["staging", "this branch"] as const) {
            for (const link of [bare, stagingEmail, branchEmail]) {
              record(link, await open(web, `${newSfu}/scheduled-meetings`, link));
            }
          }
        };
        await openEverywhere();
        await hostOpensScheduling(newSfu);
        await openEverywhere();
        expect(getScheduledMeetingById(world.store, booking.id)?.clientId, `first opened on ${firstOpenedOn}`).toBe(storedBeforeDeploy);

        const disagreements = [...outcomes.entries()]
          .filter(([, seen]) => seen.size > 1)
          .map(([link, seen]) => `${link}: ${[...seen].join(" | ")}`);
        expect(disagreements, `first opened on ${firstOpenedOn}`).toEqual([]);
        const bookingLinks = [stagingEmail, branchEmail].filter((link) => link !== bare);
        for (const link of bookingLinks) {
          expect([...outcomes.get(link)!][0], `${link}, first opened on ${firstOpenedOn}`).toMatch(new RegExp(`^booking ${booking.id} in `));
        }
        const tenants = new Set(
          [...outcomes.values()].map((seen) => [...seen][0]!).filter((outcome) => outcome.startsWith("booking")),
        );
        expect([...tenants], `first opened on ${firstOpenedOn}`).toHaveLength(1);
      }
    },
  );

  it.each(ROWS)(
    "deploying web first with default %s and a %s booking from %s refuses every link with a clear message and never touches the booking",
    async (serverDefault, bookedUnder, source) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", serverDefault);
      const { world, booking } = hostWithBooking(bookedUnder, source);
      const stagingSfu = await startSfu("staging", world);
      const links = [
        `${ORIGIN}/${ROOM}`,
        buildStagingSchedulingMeetingLink(ORIGIN, booking),
        buildSchedulingMeetingLink(ORIGIN, booking),
        `${ORIGIN}/${ROOM}?clientId=beta`,
        `${ORIGIN}/${ROOM}?clientId=${serverDefault}`,
      ];

      for (const link of links) {
        expect(await open("this branch", `${stagingSfu}/scheduled-meetings`, link), link).toBe("refused: the meeting service must be updated first");
      }
      expect(getScheduledMeetingById(world.store, booking.id)?.clientId).toBe(bookedUnder);
    },
  );
});

describe("a host whose scheduling profile moves to the default tenant keeps every booking it already had", () => {
  const movedHost = async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    const world: World = { store: createScheduledMeetingStore(), scheduling: createSchedulingStore() };
    const profile = ensureSchedulingProfile(world.scheduling, { clientId: "conclave", ...HOST });
    const retired = createEventType(world.scheduling, profile, { title: "Old intro", slug: "old-intro", isActive: true });
    const current = createEventType(world.scheduling, profile, { title: "Intro", slug: "intro", isActive: true });
    const sfu = await startSfu("this branch", world);
    return { world, profile, retired, current, sfu };
  };

  it("still lists a booking whose event type was deleted before the move", async () => {
    const { world, profile, retired, sfu } = await movedHost();
    const booking = createScheduledMeeting(
      world.store,
      { title: "Old intro", scheduledStartAt: Date.now() + 86_400_000, roomCode: ROOM, source: "booking_link", eventTypeId: retired.id },
      { clientId: "conclave", createdBy: "guest@example.com", defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
    );
    deleteEventType(world.scheduling, profile, retired.id);

    const { bookings } = (await hostRequest(sfu, "GET", "/scheduling/bookings")) as { bookings: Array<{ id: string }> };

    expect(getProfileByUser(world.scheduling, "acme", HOST.userId)?.id).toBe(profile.id);
    expect(getScheduledMeetingById(world.store, booking.id)?.clientId).toBe("conclave");
    expect(bookings.map((listed) => listed.id)).toEqual([booking.id]);
  });

  it("keeps the time of a booking whose event type was deleted before the move out of the offered slots", async () => {
    const { world, profile, retired, current, sfu } = await movedHost();
    const slotsPath = () => `/scheduling/public/${encodeURIComponent(profile.username)}/${current.slug}/slots`;
    const before = (await hostRequest(sfu, "GET", slotsPath())) as { slots: Array<{ startAt: number; endAt: number }> };
    const taken = before.slots[0]!;
    expect(taken).toBeDefined();
    createScheduledMeeting(
      world.store,
      { title: "Old intro", scheduledStartAt: taken.startAt, scheduledEndAt: taken.endAt, roomCode: ROOM, source: "booking_link", eventTypeId: retired.id },
      { clientId: "conclave", createdBy: "guest@example.com", defaultHostEmail: HOST.email, defaultHostUserId: HOST.userId },
    );
    deleteEventType(world.scheduling, profile, retired.id);

    await hostRequest(sfu, "GET", "/scheduling/profile");
    const after = (await hostRequest(sfu, "GET", slotsPath())) as { slots: Array<{ startAt: number }> };

    expect(getProfileByUser(world.scheduling, "acme", HOST.userId)?.id).toBe(profile.id);
    expect(after.slots.map((slot) => slot.startAt)).not.toContain(taken.startAt);
    expect(after.slots.length).toBeGreaterThan(0);
  });
});
