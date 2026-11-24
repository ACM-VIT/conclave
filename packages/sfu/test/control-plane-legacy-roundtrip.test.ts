import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBackend, createMemoryData } from "../server/controlPlane/backends/memory.js";
import { readLegacyDomains, type LegacyPaths } from "../server/controlPlane/legacy.js";
import { hashLegacyValue } from "../server/controlPlane/legacyHash.js";
import { beginLegacyImport, reconcileLegacy } from "../server/controlPlane/legacyImport.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { legacyCalendar, legacyMeeting, legacyProfile, legacyWebinar, writeLegacyJsonFiles } from "./support/oldSfu.js";

type Raw = Record<string, unknown>;

const SECRET = "round-trip-secret";
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

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/json-stores/${name}`, import.meta.url), "utf8"));

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-legacy-roundtrip-"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const paths = (): LegacyPaths => ({
  schedulingSqlite: join(dir, "missing.sqlite"),
  meetingsSqlite: join(dir, "missing.sqlite"),
  webinarsSqlite: join(dir, "missing.sqlite"),
  schedulingJson: join(dir, "scheduling.json"),
  meetingsJson: join(dir, "scheduled-meetings.json"),
  webinarsJson: join(dir, "scheduled-webinars.json"),
  fallbackDir: null,
});

type Files = Parameters<typeof writeLegacyJsonFiles>[1];

const roundTrip = async (files: Files): Promise<string[]> => {
  rmSync(dir, { recursive: true, force: true });
  writeLegacyJsonFiles(dir, files);
  let domains: Awaited<ReturnType<typeof readLegacyDomains>>;
  try {
    domains = await readLegacyDomains({ mode: "json", paths: paths() });
  } catch {
    return [];
  }
  const store = controlPlaneStore(createMemoryBackend(createMemoryData()));
  const begun = await store.commit(beginLegacyImport());
  if (!begun.ok) throw new Error("no ticket");
  const drifts: string[] = [];
  for (const domain of domains) {
    if (!domain.records || domain.records.length === 0) continue;
    const items = domain.records.map((record) => ({ kind: record.kind, id: record.id, copy: record }));
    const first = await store.commit(reconcileLegacy(begun.value.ticket, domain.domain, "", "json", items));
    if (!first.ok) throw new Error(first.reason);
    for (const record of domain.records) {
      const stored = await store.read((view) => view.get(record.kind, record.id));
      if (!stored) drifts.push(`${record.key} was not stored`);
      else if (hashLegacyValue(stored.value) !== record.hash) drifts.push(`${record.key} reads back changed`);
    }
    const again = await store.commit(reconcileLegacy(begun.value.ticket, domain.domain, "", "json", items));
    if (again.ok && again.value.inserted + again.value.refreshed + again.value.conflicts + again.value.deleted > 0) {
      drifts.push(`${domain.domain} changed on a second import of the same files`);
    }
  }
  return drifts;
};

type Shape = {
  name: string;
  records: () => Array<{ label: string; kind: string; record: Raw }>;
  files: (kind: string, record: Raw) => Files;
  fixtures: string[];
  whole: (name: string) => Files;
};

const profile = legacyProfile("p1", { userId: "host-user" });
const hours = { profileId: "p1", availability: { timeZone: "UTC", windows: [{ day: 1, startMinutes: 540, endMinutes: 1020 }], overrides: [], updatedAt: 1_800_000_000_000 } };
const eventType = {
  id: "event-type-1", clientId: "conclave", profileId: "p1", userId: "host-user", slug: "intro", title: "Intro", description: "",
  durationMinutes: 30, minimumNoticeMinutes: 60, bookingWindowDays: 14, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  isActive: true, requiresCalendar: false, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
};
const calendar = legacyCalendar("p1", SECRET);

const scheduling = (kind: string, record: Raw): Files => {
  const rows: Record<string, unknown[]> = { profiles: [profile], availability: [hours], eventTypes: [eventType], calendars: [calendar] };
  rows[kind] = [record];
  return rows;
};

const shapes: Shape[] = [
  {
    name: "scheduled meetings",
    records: () => [
      {
        label: "current",
        kind: "meetings",
        record: legacyMeeting("full", {
          source: "booking_link",
          attendeeName: "Guest",
          attendeeEmail: "guest@example.test",
          emailNotificationStatus: "sent",
          emailNotificationSentAt: 1_899_000_000_000,
          emailReminderStatus: "sent",
          emailReminderSentAt: 1_899_500_000_000,
          startedAt: 1_900_000_100_000,
        }),
      },
      ...(fixture("scheduled-meetings.2026-05-21.json") as Raw[]).map((record) => ({ label: "2026-05-21 file", kind: "meetings", record })),
    ],
    files: (_kind, record) => ({ meetings: [record] }),
    fixtures: ["scheduled-meetings.2026-05-21.json"],
    whole: (name) => ({ meetings: fixture(name) as unknown[] }),
  },
  {
    name: "scheduled webinars",
    records: () => [
      { label: "current", kind: "webinars", record: legacyWebinar("full", { coHosts: [{ email: "co@example.test" }], totalJoinCount: 4 }) },
      ...(fixture("scheduled-webinars.2026-05-21.json") as Raw[]).map((record) => ({ label: "2026-05-21 file", kind: "webinars", record })),
    ],
    files: (_kind, record) => ({ webinars: [record] }),
    fixtures: ["scheduled-webinars.2026-05-21.json"],
    whole: (name) => ({ webinars: fixture(name) as unknown[] }),
  },
  {
    name: "scheduling records",
    records: () => {
      const legacy = fixture("scheduling.2026-06-27.json") as Record<string, Raw[]>;
      return [
        ...Object.entries({ profiles: [profile], availability: [hours], eventTypes: [eventType], calendars: [calendar] }).flatMap(([kind, rows]) =>
          rows.map((record) => ({ label: "current", kind, record: record })),
        ),
        ...Object.entries(legacy).flatMap(([kind, rows]) => rows.map((record) => ({ label: "2026-06-27 file", kind, record }))),
      ];
    },
    files: scheduling,
    fixtures: ["scheduling.2026-06-27.json"],
    whole: (name) => fixture(name) as Files,
  },
];

describe.each(shapes)("legacy $name imported into the store", (shape) => {
  it("read back exactly as decoded, for every field missing, null, 0, empty, set or of another type", async () => {
    const drifts: string[] = [];
    for (const { label, kind, record } of shape.records()) {
      for (const field of Object.keys(record)) {
        for (const [variantName, variant] of VARIANTS) {
          const found = await roundTrip(shape.files(kind, withVariant(record, field, variant(record[field]))));
          drifts.push(...found.map((drift) => `${label} ${kind}.${field} = ${variantName}: ${drift}`));
        }
      }
    }
    expect(drifts).toEqual([]);
  }, 180_000);

  it("read back exactly as decoded for random mixes of those values", async () => {
    const next = random(272);
    const drifts: string[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      for (const { label, kind, record } of shape.records()) {
        const mixed = Object.keys(record).reduce(
          (current, field) => withVariant(current, field, VARIANTS[Math.floor(next() * VARIANTS.length)][1](record[field])),
          record,
        );
        const found = await roundTrip(shape.files(kind, mixed));
        drifts.push(...found.map((drift) => `${label} ${kind} mix ${attempt}: ${drift}`));
      }
    }
    expect(drifts.slice(0, 5)).toEqual([]);
  }, 180_000);

  it.each(shape.fixtures)("read back an older SFU's file (%s) unchanged", async (name) => {
    expect(await roundTrip(shape.whole(name))).toEqual([]);
  });
});
