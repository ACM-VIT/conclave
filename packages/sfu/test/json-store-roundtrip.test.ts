import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonStoreAdapter } from "../server/jsonStoreUpgrade.js";
import { createScheduledMeeting, createScheduledMeetingStore, scheduledMeetingJsonStore } from "../server/scheduledMeetings.js";
import { createScheduledWebinar, createScheduledWebinarStore, scheduledWebinarJsonStore } from "../server/scheduledWebinars.js";
import { createSchedulingStore, ensureSchedulingProfile, schedulingJsonStore } from "../server/scheduling.js";

type Raw = Record<string, unknown>;

const MISSING = Symbol("missing");
const VARIANTS: Array<[string, (value: unknown) => unknown]> = [
  ["missing", () => MISSING],
  ["null", () => null],
  ["0", () => 0],
  ["empty", () => ""],
  ["set", (value) => value],
  ["text", () => "text"],
  ["true", () => true],
  ["number", () => 1_716_300_000_000],
];

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Raw).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const withVariant = (record: Raw, field: string, variant: unknown): Raw => {
  const next = { ...record };
  if (variant === MISSING) delete next[field];
  else next[field] = variant;
  return next;
};

const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/json-stores/${name}`, import.meta.url), "utf8"));
const plain = <T>(value: T): Raw => JSON.parse(JSON.stringify(value)) as Raw;
const HOST = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-roundtrip-"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", "round-trip-secret");
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const roundTrip = <Snapshot>(adapter: JsonStoreAdapter<Snapshot>, data: unknown): { first: string; second: string } | null => {
  let decoded: Snapshot;
  try {
    decoded = adapter.decode(data);
  } catch {
    return null;
  }
  const path = join(dir, `store-${Math.random().toString(36).slice(2)}.json`);
  adapter.write(path, decoded);
  return { first: stableJson(decoded), second: stableJson(adapter.decode(JSON.parse(readFileSync(path, "utf8")))) };
};

type Shape = {
  name: string;
  adapter: JsonStoreAdapter<unknown>;
  records: () => Array<{ label: string; kind: string; record: Raw }>;
  wrap: (kind: string, record: Raw) => unknown;
  fixtures: string[];
};

const meetingRecord = () =>
  plain({
    ...createScheduledMeeting(createScheduledMeetingStore(), { title: "Full", scheduledStartAt: 1_900_000_000_000 }, HOST),
    source: "booking_link",
    attendeeName: "Guest",
    attendeeEmail: "guest@example.test",
    emailNotificationStatus: "sent",
    emailNotificationSentAt: 1_899_000_000_000,
    emailReminderStatus: "sent",
    emailReminderSentAt: 1_899_500_000_000,
    startedAt: 1_900_000_100_000,
  });

const webinarRecord = () =>
  plain(createScheduledWebinar(createScheduledWebinarStore(), { title: "Full webinar", scheduledStartAt: 1_900_000_000_000, linkSlug: "full-webinar" }, HOST).webinar);

const schedulingBase = () => {
  const profile = plain(ensureSchedulingProfile(createSchedulingStore(), { clientId: "conclave", userId: "host-user", email: "host@example.test", name: "Host" }));
  const availability = { profileId: profile.id, availability: { timeZone: "UTC", windows: [{ day: 1, startMinutes: 540, endMinutes: 1020 }], overrides: [], updatedAt: 1_800_000_000_000 } };
  const eventType = {
    id: "event-type-1", clientId: "conclave", profileId: profile.id, userId: "host-user", slug: "intro", title: "Intro", description: "",
    durationMinutes: 30, minimumNoticeMinutes: 60, bookingWindowDays: 14, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    isActive: true, requiresCalendar: false, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
  };
  const calendar = {
    id: "calendar-1", clientId: "conclave", profileId: profile.id, userId: "host-user", provider: "google", status: "connected",
    email: "host@example.test", calendarId: "primary", accessToken: "access-token", refreshToken: "refresh-token",
    accessTokenExpiresAt: 1_800_000_000_000, scopes: [], connectedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, error: null,
  };
  return { profiles: [profile], availability: [availability], eventTypes: [eventType], calendars: [calendar] } as Record<string, Raw[]>;
};

const shapes: Shape[] = [
  {
    name: "scheduled meetings",
    adapter: scheduledMeetingJsonStore as JsonStoreAdapter<unknown>,
    records: () => [
      { label: "current", kind: "meetings", record: meetingRecord() },
      ...(fixture("scheduled-meetings.2026-05-21.json") as Raw[]).map((record) => ({ label: "2026-05-21 file", kind: "meetings", record })),
    ],
    wrap: (_kind, record) => [record],
    fixtures: ["scheduled-meetings.2026-05-21.json"],
  },
  {
    name: "scheduled webinars",
    adapter: scheduledWebinarJsonStore as JsonStoreAdapter<unknown>,
    records: () => [
      { label: "current", kind: "webinars", record: webinarRecord() },
      ...(fixture("scheduled-webinars.2026-05-21.json") as Raw[]).map((record) => ({ label: "2026-05-21 file", kind: "webinars", record })),
    ],
    wrap: (_kind, record) => [record],
    fixtures: ["scheduled-webinars.2026-05-21.json"],
  },
  {
    name: "scheduling records",
    adapter: schedulingJsonStore as JsonStoreAdapter<unknown>,
    records: () => {
      const current = schedulingBase();
      const legacy = fixture("scheduling.2026-06-27.json") as Record<string, Raw[]>;
      return [current, legacy].flatMap((snapshot, index) =>
        Object.entries(snapshot).flatMap(([kind, rows]) =>
          rows.map((record) => ({ label: index === 0 ? "current" : "2026-06-27 file", kind, record })),
        ),
      );
    },
    wrap: (kind, record) => ({ ...schedulingBase(), [kind]: [record] }),
    fixtures: ["scheduling.2026-06-27.json"],
  },
];

describe.each(shapes)("the $name JSON store", (shape) => {
  it("reads back exactly what it decoded, for every field missing, null, 0, empty, set or of another type", () => {
    const drifts: string[] = [];
    for (const { label, kind, record } of shape.records()) {
      for (const field of Object.keys(record)) {
        for (const [variantName, variant] of VARIANTS) {
          const result = roundTrip(shape.adapter, shape.wrap(kind, withVariant(record, field, variant(record[field]))));
          if (result && result.first !== result.second) drifts.push(`${label} ${kind}.${field} = ${variantName}`);
        }
      }
    }
    expect(drifts).toEqual([]);
  }, 180_000);

  it("reads back exactly what it decoded for random mixes of those values", () => {
    const next = random(272);
    const drifts: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      for (const { label, kind, record } of shape.records()) {
        const mixed = Object.keys(record).reduce(
          (current, field) => withVariant(current, field, VARIANTS[Math.floor(next() * VARIANTS.length)][1](record[field])),
          record,
        );
        const result = roundTrip(shape.adapter, shape.wrap(kind, mixed));
        if (result && result.first !== result.second) drifts.push(`${label} ${kind} mix ${attempt}`);
      }
    }
    expect(drifts.slice(0, 5)).toEqual([]);
  }, 180_000);

  it.each(shape.fixtures)("reads back an older SFU's file (%s) unchanged", (name) => {
    const result = roundTrip(shape.adapter, fixture(name));
    expect(result).not.toBeNull();
    expect(result?.second).toBe(result?.first);
  });
});
