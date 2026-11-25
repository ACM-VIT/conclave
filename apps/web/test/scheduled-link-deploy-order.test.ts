import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScheduledMeetingRoutes } from "../../../packages/sfu/server/http/scheduledMeetingRoutes.js";
import {
  createScheduledMeeting,
  createScheduledMeetingStore,
  getScheduledMeetingById,
} from "../../../packages/sfu/server/scheduledMeetings.js";
import { buildSchedulingMeetingLink } from "../../../packages/sfu/server/schedulingLinks.js";
import type { SfuState } from "../../../packages/sfu/server/state.js";
import { registerScheduledMeetingRoutes as registerStagingScheduledMeetingRoutes } from "./staging-sfu/scheduledMeetingRoutes.js";
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

const startSfu = async (sfu: Sfu, store: ReturnType<typeof createScheduledMeetingStore>) => {
  const app = express();
  const register = sfu === "staging" ? registerStagingScheduledMeetingRoutes : registerScheduledMeetingRoutes;
  register(app, { state: { scheduledMeetings: store } as unknown as SfuState, sfuSecret: SECRET });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/scheduled-meetings`;
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
  (["conclave", "acme", "beta"] as const).map((bookedUnder) => [serverDefault, bookedUnder] as const),
);

describe("a scheduled link opens one booking whichever side deploys first", () => {
  it.each(ROWS)(
    "deploying the SFU first with default %s and a booking under %s keeps every link on one booking and changes no data after the SFU deploy",
    async (serverDefault, bookedUnder) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", serverDefault);
      for (const firstOpenedOn of ["staging", "after the SFU deploy"] as const) {
        const store = createScheduledMeetingStore();
        const booking = createScheduledMeeting(
          store,
          { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: ROOM },
          { clientId: bookedUnder, createdBy: "host@example.com", defaultHostEmail: "host@example.com", defaultHostUserId: null },
        );
        const bare = `${ORIGIN}/${ROOM}`;
        const stagingEmail = buildStagingSchedulingMeetingLink(ORIGIN, booking);
        const outcomes = new Map<string, Set<Outcome>>();
        const record = (link: string, outcome: Outcome) => {
          const seen = outcomes.get(link) ?? new Set<Outcome>();
          seen.add(outcome);
          outcomes.set(link, seen);
        };

        if (firstOpenedOn === "staging") {
          const stagingSfu = await startSfu("staging", store);
          for (const link of [bare, stagingEmail]) record(link, await open("staging", stagingSfu, link));
        }

        const storedBeforeDeploy = getScheduledMeetingById(store, booking.id)?.clientId;
        const newSfu = await startSfu("this branch", store);
        const branchEmail = buildSchedulingMeetingLink(ORIGIN, getScheduledMeetingById(store, booking.id) ?? booking);
        for (const web of ["staging", "this branch"] as const) {
          for (const link of [bare, stagingEmail, branchEmail]) record(link, await open(web, newSfu, link));
        }
        expect(getScheduledMeetingById(store, booking.id)?.clientId).toBe(storedBeforeDeploy);

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
    "deploying web first with default %s and a booking under %s refuses every link with a clear message and never touches the booking",
    async (serverDefault, bookedUnder) => {
      vi.stubEnv("SFU_CLIENT_ID", serverDefault);
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", serverDefault);
      const store = createScheduledMeetingStore();
      const booking = createScheduledMeeting(
        store,
        { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: ROOM },
        { clientId: bookedUnder, createdBy: "host@example.com", defaultHostEmail: "host@example.com", defaultHostUserId: null },
      );
      const stagingSfu = await startSfu("staging", store);
      const links = [
        `${ORIGIN}/${ROOM}`,
        buildStagingSchedulingMeetingLink(ORIGIN, booking),
        buildSchedulingMeetingLink(ORIGIN, booking),
        `${ORIGIN}/${ROOM}?clientId=beta`,
        `${ORIGIN}/${ROOM}?clientId=${serverDefault}`,
      ];

      for (const link of links) {
        expect(await open("this branch", stagingSfu, link), link).toBe("refused: the meeting service must be updated first");
      }
      expect(getScheduledMeetingById(store, booking.id)?.clientId).toBe(bookedUnder);
    },
  );
});
