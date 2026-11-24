import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { entities } from "../server/controlPlane/entities.js";
import { DATA_KINDS, type DataKind, type UniqueIndex } from "../server/controlPlane/model.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { hashCoHostInviteToken } from "../server/scheduledWebinars.js";
import { legacyMeeting, legacyProfile, legacyWebinar, writeLegacyJsonFiles } from "./support/oldSfu.js";

type Rival = {
  index: UniqueIndex;
  kind: DataKind;
  pair: (stamp: { first: number; second: number }) => [Record<string, unknown>, Record<string, unknown>];
  files: (rows: Record<string, unknown>[]) => Parameters<typeof writeLegacyJsonFiles>[1];
};

const eventType = (id: string, fields: Record<string, unknown>) => ({
  id, clientId: "conclave", profileId: "p", userId: "user-p", slug: "intro", title: id, description: "",
  durationMinutes: 30, minimumNoticeMinutes: 0, bookingWindowDays: 14, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  isActive: true, requiresCalendar: false, createdAt: 100, ...fields,
});

const RIVALS: Rival[] = [
  {
    index: "profileUser",
    kind: "profile",
    pair: ({ first, second }) => [
      legacyProfile("a", { userId: "shared-user", username: "host-a", updatedAt: first }),
      legacyProfile("b", { userId: "shared-user", username: "host-b", updatedAt: second }),
    ],
    files: (rows) => ({ profiles: rows }),
  },
  {
    index: "profileUsername",
    kind: "profile",
    pair: ({ first, second }) => [
      legacyProfile("a", { userId: "user-a", username: "shared-name", updatedAt: first }),
      legacyProfile("b", { userId: "user-b", username: "Shared-Name", updatedAt: second }),
    ],
    files: (rows) => ({ profiles: rows }),
  },
  {
    index: "eventSlug",
    kind: "eventType",
    pair: ({ first, second }) => [eventType("a", { updatedAt: first }), eventType("b", { updatedAt: second })],
    files: (rows) => ({ profiles: [legacyProfile("p")], eventTypes: rows }),
  },
  {
    index: "meetingCode",
    kind: "meeting",
    pair: ({ first, second }) => [
      legacyMeeting("a", { roomCode: "shared-code", updatedAt: first }),
      legacyMeeting("b", { roomCode: "shared-code", updatedAt: second }),
    ],
    files: (rows) => ({ meetings: rows }),
  },
  {
    index: "webinarSlug",
    kind: "webinar",
    pair: ({ first, second }) => [
      legacyWebinar("a", { linkSlug: "shared-slug", updatedAt: first }),
      legacyWebinar("b", { linkSlug: "shared-slug", updatedAt: second }),
    ],
    files: (rows) => ({ webinars: rows }),
  },
  {
    index: "webinarRoom",
    kind: "webinar",
    pair: ({ first, second }) => [
      legacyWebinar("a", { roomId: "sched-shared", updatedAt: first }),
      legacyWebinar("b", { roomId: "sched-shared", updatedAt: second }),
    ],
    files: (rows) => ({ webinars: rows }),
  },
  {
    index: "cohostToken",
    kind: "webinar",
    pair: ({ first, second }) => [
      legacyWebinar("a", { coHostInviteTokenHash: hashCoHostInviteToken("shared"), coHostInviteTokenCreatedAt: 90, updatedAt: first }),
      legacyWebinar("b", { coHostInviteTokenHash: hashCoHostInviteToken("shared"), coHostInviteTokenCreatedAt: 90, updatedAt: second }),
    ],
    files: (rows) => ({ webinars: rows }),
  },
];

let dir = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const stores: ControlPlaneStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-unique-rivals-"));
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "json");
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(dir, "import"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "old", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "old", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "old", "scheduled-webinars.json"));
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const start = async () => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  stores.push(store);
  return store;
};

const saveCopy = (files: Parameters<typeof writeLegacyJsonFiles>[1]) =>
  writeLegacyJsonFiles(join(dir, "import", "sfu-a", "20261124T000000000Z-rivals"), files);

const holders = (store: ControlPlaneStore, rival: Rival) =>
  store.read((view) => {
    const all = view.all(rival.kind);
    const key = entities[rival.kind].unique(all[0].value as never).find(([index]) => index === rival.index)![1];
    return { ids: all.map((stored) => (stored.value as { id: string }).id).sort(), holder: view.owner(rival.index, key) };
  });

describe("unique keys claimed by rival legacy records", () => {
  it("covers every unique index a stored kind declares", () => {
    const declared = new Set(RIVALS.map((rival) => rival.index));
    const indexes = new Set<string>();
    for (const rival of RIVALS) {
      for (const row of rival.pair({ first: 1, second: 2 })) {
        const decoded = entities[rival.kind].decode(row);
        if (decoded) for (const [index] of entities[rival.kind].unique(decoded as never)) indexes.add(index);
      }
    }
    expect([...declared].sort()).toEqual([...indexes].sort());
    expect(DATA_KINDS.filter((kind) => RIVALS.some((rival) => rival.kind === kind)).length).toBeGreaterThan(0);
  });

  it.each(RIVALS)("keep both $index rivals in one old store and give the key to the newer", async (rival) => {
    writeLegacyJsonFiles(join(dir, "old"), rival.files(rival.pair({ first: 100, second: 200 })));
    const store = await start();
    expect(await holders(store, rival)).toEqual({ ids: ["a", "b"], holder: "b" });
    expect(warn.mock.calls.some((call) => String(call.join(" ")).includes(`legacy ${rival.kind}:a kept without ${rival.index}:`))).toBe(true);
  });

  it.each(RIVALS)("keep a $index rival from a container copy without the key the stored record holds", async (rival) => {
    const [first, second] = rival.pair({ first: 100, second: 200 });
    writeLegacyJsonFiles(join(dir, "old"), rival.files([first]));
    saveCopy(rival.files([second]));
    const store = await start();
    expect(await holders(store, rival)).toEqual({ ids: ["a", "b"], holder: "a" });
    expect(warn.mock.calls.some((call) => String(call.join(" ")).includes(`legacy ${rival.kind}:b kept without ${rival.index}:`))).toBe(true);
  });
});
