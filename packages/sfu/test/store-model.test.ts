import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  createRedisScheduledMeetingPersistence,
  createScheduledMeetingPersistence,
  createSqliteScheduledMeetingPersistence,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import {
  createRedisSchedulingPersistence,
  createSchedulingPersistence,
  createSchedulingStore,
  createSqliteSchedulingPersistence,
  ensureSchedulingProfile,
  type SchedulingPersistence,
} from "../server/scheduling.js";
import { createSfuState, type SfuState } from "../server/state.js";
import type { ScheduledMeeting } from "../types.js";
import { hasRedis, startRedis } from "./support/redisServer.js";

type Mode = "sqlite" | "json" | "redis";
type SfuName = "A" | "B";
type Reply = { status: number; body: Record<string, unknown> };
type Call = (method: string, path: string, body?: unknown) => Promise<Reply>;
type Sfu = { name: SfuName; state: SfuState; server: Server; call: Call; inflight: number };
type Op = { sfu: SfuName; kind: string; id?: string; reply?: Reply };

const SEEDS = Number(process.env.STORE_MODEL_SEEDS ?? 6);
const STEPS = Number(process.env.STORE_MODEL_STEPS ?? 40);
const MAX_INFLIGHT = 3;
const HOST_HEADERS = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const LEGACY_STAMP = 1_000;
const LEGACY_WINDOWS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));
const RECOVERED_OVERRIDE = { date: "2099-01-01", unavailable: true };

let redis: { url: string; stop: () => void } | null = null;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Gate {
  auto = true;
  parked: Array<{ label: string; release: () => void }> = [];

  admit(label: string): Promise<void> {
    if (this.auto) return Promise.resolve();
    return new Promise((resolve) => this.parked.push({ label, release: resolve }));
  }

  releaseAt(index: number): string {
    const [entry] = this.parked.splice(index, 1);
    entry.release();
    return entry.label;
  }

  drain(): void {
    this.auto = true;
    for (const entry of this.parked.splice(0)) entry.release();
  }
}

const WRITES: Array<[keyof SfuState, string[]]> = [
  ["scheduledMeetingPersistence", ["saveChanged", "importIfNewer", "claimEmailReminder"]],
  ["scheduledWebinarPersistence", ["saveChanged", "importIfNewer"]],
  ["schedulingPersistence", ["commit", "importIfNewer"]],
];

const describeWrite = (args: unknown[]): string => {
  const change = args[0] as { records?: Array<{ kind: string; updatedAt: number }>; kind?: string; updatedAt?: number } | unknown[];
  if (Array.isArray(change)) return change.map((record) => (record as { updatedAt?: number }).updatedAt).join(",");
  if (change && "records" in change && change.records) return change.records.map((record) => `${record.kind}@${record.updatedAt}`).join(",");
  if (change && "kind" in change) return `${change.kind}@${change.updatedAt}`;
  return "";
};

const gateWrites = (
  name: SfuName,
  state: SfuState,
  gate: Gate,
  afterMeetingSave: (result: unknown) => Promise<void>,
  note: (line: string) => void,
) => {
  for (const [key, methods] of WRITES) {
    const persistence = state[key] as Record<string, (...args: unknown[]) => unknown> | null;
    if (!persistence) continue;
    for (const method of methods) {
      if (typeof persistence[method] !== "function") continue;
      const original = persistence[method].bind(persistence);
      persistence[method] = async (...args: unknown[]) => {
        const label = `${name} ${String(key).replace("Persistence", "")}.${method}(${describeWrite(args)})`;
        await gate.admit(label);
        const result = await original(...args);
        note(`done ${label}`);
        if (key === "scheduledMeetingPersistence" && method === "saveChanged") await afterMeetingSave(result);
        return result;
      };
    }
  }
};

const configureMode = (mode: Mode, dir: string, prefix: string) => {
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(dir, "import"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "json", "scheduled-webinars.json"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", mode);
  vi.stubEnv("SCHEDULING_PERSISTENCE", mode);
  vi.stubEnv("SCHEDULED_WEBINARS_PERSISTENCE", mode === "redis" ? "sqlite" : mode);
  vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", mode === "redis" ? redis!.url : "");
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", prefix);
};

type Storage = {
  meetings: Map<string, ScheduledMeeting>;
  webinars: Map<string, { title: string; status: string; updatedAt: number }>;
  eventTypes: Map<string, { title: string; updatedAt: number }>;
  hours: Map<string, { windows: unknown; overrides: unknown; updatedAt: number }>;
};

const meetingView = (meeting: Partial<ScheduledMeeting> | undefined) =>
  meeting ? `${meeting.title}|${meeting.status}|${meeting.scheduledStartAt}|${meeting.updatedAt}` : "absent";
const webinarView = (webinar: { title?: unknown; status?: unknown; updatedAt?: unknown } | undefined) =>
  webinar ? `${webinar.title}|${webinar.status}|${webinar.updatedAt}` : "absent";
const eventTypeView = (eventType: { title?: unknown; updatedAt?: unknown } | undefined) =>
  eventType ? `${eventType.title}|${eventType.updatedAt}` : "absent";
const hoursView = (hours: { windows?: unknown; overrides?: unknown; updatedAt?: unknown } | undefined, stamped = true) =>
  hours ? `${JSON.stringify(hours.windows)}|${JSON.stringify(hours.overrides)}${stamped ? `|${hours.updatedAt}` : ""}` : "absent";

const contentOf = (storage: Storage) =>
  JSON.stringify({
    meetings: [...storage.meetings].map(([id, meeting]) => [id, meeting.title, meeting.status, meeting.scheduledStartAt]).sort(),
    webinars: [...storage.webinars].map(([id, webinar]) => [id, webinar.title, webinar.status]).sort(),
    eventTypes: [...storage.eventTypes].map(([id, eventType]) => [id, eventType.title]).sort(),
    hours: [...storage.hours].map(([id, hours]) => [id, hoursView(hours, false)]).sort(),
  });

const dateIn = (timeZone: string, at: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

const runModel = async (mode: Mode, seed: number, dir: string): Promise<string[]> => {
  const prefix = `model:${mode}:${seed}:${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  configureMode(mode, dir, prefix);
  const rand = random(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const gate = new Gate();
  const violations: string[] = [];
  const trace: string[] = [];
  const confirmedDeleted = new Set<string>();
  const seenBookings = new Set<string>();
  const meetingIds: string[] = [];
  const webinarIds: string[] = [];
  const completed: Op[] = [];
  const pending = new Set<Promise<void>>();
  const closers: Array<() => unknown> = [];
  const observerMirror = join(dir, "observer-mirror.sqlite");

  const observers = {
    meetings: (): ScheduledMeetingPersistence =>
      mode === "redis"
        ? createRedisScheduledMeetingPersistence(redis!.url, prefix, createSqliteScheduledMeetingPersistence(observerMirror))
        : createScheduledMeetingPersistence(),
    scheduling: (): SchedulingPersistence =>
      mode === "redis"
        ? createRedisSchedulingPersistence(redis!.url, prefix, createSqliteSchedulingPersistence(observerMirror))
        : createSchedulingPersistence(),
  };

  const readStorage = async (): Promise<Storage> => {
    const meetingStore = observers.meetings();
    const schedulingStore = observers.scheduling();
    try {
      const meetings = new Map((await meetingStore.load()).map((meeting) => [meeting.id, meeting]));
      const webinars = new Map(createScheduledWebinarPersistence().loadState().records.map((webinar) => [webinar.id, webinar]));
      const snapshot = await schedulingStore.load();
      const profiles = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
      const hours = new Map(
        snapshot.availability.map((entry) => {
          const availability = entry.availability as { windows?: unknown; overrides?: unknown; updatedAt?: unknown };
          const updatedAt = Number(availability.updatedAt ?? profiles.get(entry.profileId)?.updatedAt ?? 0);
          return [entry.profileId, { windows: availability.windows, overrides: availability.overrides ?? [], updatedAt }];
        }),
      );
      return { meetings, webinars, eventTypes: new Map(snapshot.eventTypes.map((eventType) => [eventType.id, eventType])), hours };
    } finally {
      await meetingStore.close?.();
      await schedulingStore.close?.();
    }
  };

  const flag = (message: string) => {
    if (violations.some((violation) => violation.startsWith(message))) return;
    violations.push(process.env.STORE_MODEL_TRACE ? `${message}\n      trace: ${trace.slice(-14).join(" / ")}` : message);
  };

  const sfus: Record<SfuName, Sfu | null> = { A: null, B: null };
  let profileId = "";
  let eventTypeId = "";
  let username = "";
  let slug = "";
  let timeZone = "UTC";
  let slots: number[] = [];
  let bookDate = "";

  const afterMeetingSave = async (result: unknown) => {
    for (const commit of (result ?? []) as Array<{ id: string; record: ScheduledMeeting | null }>) {
      const record = commit.record;
      if (!record || record.source !== "booking_link" || seenBookings.has(record.id)) continue;
      seenBookings.add(record.id);
      const storage = await readStorage();
      const hours = storage.hours.get(profileId);
      const closed = ((hours?.overrides ?? []) as Array<{ date?: string; unavailable?: boolean }>).some(
        (override) => override.unavailable && override.date === dateIn(timeZone, record.scheduledStartAt),
      );
      if (closed) flag(`a booking committed into hours storage already had closed (${trace.at(-1) ?? "start"})`);
    }
  };

  const startSfu = async (name: SfuName): Promise<Sfu> => {
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: `model-${name}`, instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    await initScheduledWebinars(state);
    await initScheduledMeetings(state);
    await initScheduling(state);
    gateWrites(name, state, gate, afterMeetingSave, (line) => trace.push(line));
    const server = createServer(createSfuApp({ state, config, getIo: () => null }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const call: Call = async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "conclave", "content-type": "application/json", ...HOST_HEADERS },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { status: response.status, body: {} };
      }
    };
    return { name, state, server, call, inflight: 0 };
  };

  const stopSfu = async (sfu: Sfu) => {
    await new Promise<void>((resolve) => sfu.server.close(() => resolve()));
    sfu.server.closeAllConnections?.();
    await sfu.state.scheduledMeetingPersistence?.close?.();
    await sfu.state.schedulingPersistence?.close?.();
    sfu.state.scheduledWebinarPersistence?.close?.();
  };
  closers.push(async () => {
    for (const sfu of [sfus.A, sfus.B]) if (sfu) await stopSfu(sfu);
  });

  const memoryMatchesStorage = (
    sfu: Sfu,
    storage: Storage,
    ids: { meetings?: string[]; webinars?: string[]; eventType?: boolean; hours?: boolean },
    when: string,
  ) => {
    for (const id of ids.meetings ?? []) {
      const held = meetingView(sfu.state.scheduledMeetings.byId.get(id));
      const stored = meetingView(storage.meetings.get(id));
      if (held !== stored) flag(`${when}: SFU memory holds meeting "${held}" but storage holds "${stored}"`);
    }
    for (const id of ids.webinars ?? []) {
      const held = webinarView(sfu.state.scheduledWebinars.byId.get(id));
      const stored = webinarView(storage.webinars.get(id));
      if (held !== stored) flag(`${when}: SFU memory holds webinar "${held}" but storage holds "${stored}"`);
    }
    if (ids.eventType) {
      const heldType = eventTypeView(sfu.state.scheduling.eventTypesById.get(eventTypeId));
      const storedType = eventTypeView(storage.eventTypes.get(eventTypeId));
      if (heldType !== storedType) flag(`${when}: SFU memory holds event type "${heldType}" but storage holds "${storedType}"`);
    }
    if (ids.hours) {
      const heldHours = hoursView(sfu.state.scheduling.availabilityByProfileId.get(profileId));
      const storedHours = hoursView(storage.hours.get(profileId));
      if (heldHours !== storedHours) flag(`${when}: SFU memory holds hours "${heldHours}" but storage holds "${storedHours}"`);
    }
  };

  const checkCompleted = async () => {
    if (completed.length === 0) return;
    const storage = await readStorage();
    for (const op of completed.splice(0)) {
      const sfu = sfus[op.sfu]!;
      const reply = op.reply!;
      const ok = reply.status >= 200 && reply.status < 300;
      const when = `${op.kind} answered ${reply.status}`;
      if (op.kind === "edit event type" && ok) {
        const returned = (reply.body.eventType as { title?: string } | undefined)?.title;
        if (returned !== storage.eventTypes.get(eventTypeId)?.title) {
          flag(`${when} returned event type "${returned}" but storage kept "${storage.eventTypes.get(eventTypeId)?.title}"`);
        }
      }
      if ((op.kind === "close hours" || op.kind === "open hours") && ok) {
        const returned = JSON.stringify((reply.body.availability as { overrides?: unknown } | undefined)?.overrides);
        const stored = JSON.stringify(storage.hours.get(profileId)?.overrides);
        if (returned !== stored) flag(`${when} returned overrides ${returned} but storage kept ${stored}`);
      }
      if ((op.kind === "edit meeting" || op.kind === "create meeting") && ok) {
        const returned = (reply.body.scheduledMeeting as { title?: string } | undefined)?.title;
        if (returned !== storage.meetings.get(op.id!)?.title) {
          flag(`${when} returned meeting "${returned}" but storage kept "${storage.meetings.get(op.id!)?.title ?? "nothing"}"`);
        }
      }
      if ((op.kind === "edit webinar" || op.kind === "create webinar") && ok) {
        const returned = (reply.body.scheduledWebinar as { title?: string } | undefined)?.title;
        if (returned !== storage.webinars.get(op.id!)?.title) {
          flag(`${when} returned webinar "${returned}" but storage kept "${storage.webinars.get(op.id!)?.title ?? "nothing"}"`);
        }
      }
      if (op.kind === "delete meeting" && ok) {
        if (storage.meetings.has(op.id!)) flag(`${when} but storage still holds the meeting`);
        else confirmedDeleted.add(op.id!);
      }
      if (op.kind === "delete webinar" && ok) {
        if (storage.webinars.has(op.id!)) flag(`${when} but storage still holds the webinar`);
        else confirmedDeleted.add(op.id!);
      }
      if (op.kind === "book" && reply.status === 201) {
        const id = (reply.body.booking as { id?: string } | undefined)?.id;
        if (id && !storage.meetings.has(id)) flag(`${when} but storage holds no such booking`);
      }
      if (!ok) continue;
      if (op.kind.includes("meeting")) memoryMatchesStorage(sfu, storage, { meetings: [op.id!] }, `after ${when}, the SFU that ran it`);
      if (op.kind.includes("webinar")) memoryMatchesStorage(sfu, storage, { webinars: [op.id!] }, `after ${when}, the SFU that ran it`);
      if (op.kind.includes("event type")) memoryMatchesStorage(sfu, storage, { eventType: true }, `after ${when}, the SFU that ran it`);
      if (op.kind.includes("hours")) memoryMatchesStorage(sfu, storage, { hours: true }, `after ${when}, the SFU that ran it`);
    }
  };

  const checkNoResurrection = async () => {
    if (confirmedDeleted.size === 0) return;
    const storage = await readStorage();
    for (const id of [...confirmedDeleted]) {
      const back = storage.meetings.has(id) ? "meeting" : storage.webinars.has(id) ? "webinar" : null;
      if (!back) continue;
      confirmedDeleted.delete(id);
      flag(`a ${back} deleted with a 200 is back in storage (${trace.at(-1)})`);
    }
  };

  const launch = (sfu: Sfu, kind: string, id: string | undefined, run: () => Promise<Reply>) => {
    sfu.inflight += 1;
    trace.push(`${sfu.name} starts ${kind}${id ? ` ${id.slice(0, 6)}` : ""}`);
    const task = run()
      .then((reply) => {
        if (kind.startsWith("create") && reply.status < 300) {
          const created = (reply.body.scheduledMeeting ?? reply.body.scheduledWebinar) as { id?: string } | undefined;
          if (created?.id) {
            (kind === "create meeting" ? meetingIds : webinarIds).push(created.id);
            id = created.id;
          }
        }
        completed.push({ sfu: sfu.name, kind, id, reply });
        trace.push(`${sfu.name} ${kind} -> ${reply.status}`);
      })
      .catch((error: unknown) => flag(`${kind} threw ${(error as Error).message}`))
      .finally(() => {
        sfu.inflight -= 1;
        pending.delete(task);
      });
    pending.add(task);
  };

  const settle = async () => {
    let last = "";
    let stable = 0;
    for (let round = 0; round < 500 && stable < 4; round += 1) {
      await sleep(2);
      const signature = `${gate.parked.length}:${completed.length}:${pending.size}`;
      stable = signature === last ? stable + 1 : 0;
      last = signature;
    }
  };

  const quiesce = async () => {
    gate.auto = false;
    for (let round = 0; round < 200 && (pending.size > 0 || gate.parked.length > 0); round += 1) {
      if (gate.parked.length > 0) trace.push(`release ${gate.releaseAt(0)}`);
      await settle();
      await checkCompleted();
      await checkNoResurrection();
    }
    if (pending.size > 0) flag(`an operation never finished (${trace.at(-1)})`);
  };

  const startOp = (sfu: Sfu) => {
    const ops: Array<() => void> = [
      () => launch(sfu, "edit event type", undefined, () => sfu.call("PATCH", `/scheduling/event-types/${eventTypeId}`, { title: `title-${Math.floor(rand() * 1e6)}` })),
      () => launch(sfu, "edit event type", undefined, () => sfu.call("PATCH", `/scheduling/event-types/${eventTypeId}`, { title: `title-${Math.floor(rand() * 1e6)}` })),
      () => {
        const close = rand() < 0.5;
        launch(sfu, close ? "close hours" : "open hours", undefined, async () => {
          const { availability } = (await sfu.call("GET", "/scheduling/availability/default")).body as { availability: Record<string, unknown> };
          const overrides = close ? [{ date: bookDate, unavailable: true }] : [];
          return sfu.call("PUT", "/scheduling/availability/default", { ...availability, overrides });
        });
      },
      () =>
        launch(sfu, "book", undefined, () =>
          sfu.call("POST", `/scheduling/public/${username}/${slug}/book`, { startAt: pick(slots), attendeeName: "Guest", attendeeEmail: "guest@example.test" }),
        ),
      () => launch(sfu, "create meeting", undefined, () => sfu.call("POST", "/scheduled-meetings", { title: `meeting-${Math.floor(rand() * 1e6)}`, scheduledStartAt: Date.now() + 86_400_000 })),
      () => {
        if (meetingIds.length === 0) return;
        const id = pick(meetingIds.slice(-3));
        launch(sfu, "edit meeting", id, () => sfu.call("PATCH", `/scheduled-meetings/${id}`, { title: `meeting-${Math.floor(rand() * 1e6)}` }));
      },
      () => {
        if (meetingIds.length === 0) return;
        const id = pick(meetingIds.slice(-3));
        launch(sfu, "delete meeting", id, () => sfu.call("DELETE", `/scheduled-meetings/${id}`));
      },
      () =>
        launch(sfu, "create webinar", undefined, () =>
          sfu.call("POST", "/scheduled-webinars", { title: `webinar-${Math.floor(rand() * 1e6)}`, scheduledStartAt: Date.now() + 86_400_000 }),
        ),
      () => {
        if (webinarIds.length === 0) return;
        const id = pick(webinarIds.slice(-3));
        launch(sfu, "edit webinar", id, () => sfu.call("PATCH", `/scheduled-webinars/${id}`, { title: `webinar-${Math.floor(rand() * 1e6)}` }));
      },
      () => {
        if (webinarIds.length === 0) return;
        const id = pick(webinarIds.slice(-3));
        launch(sfu, "delete webinar", id, () => sfu.call("DELETE", `/scheduled-webinars/${id}`));
      },
    ];
    pick(ops)();
  };

  const exclusive = async (kind: "reload" | "restart" | "recover hours", sfu: Sfu) => {
    await quiesce();
    gate.auto = true;
    trace.push(`${sfu.name} ${kind}`);
    const before = await readStorage();
    if (kind === "reload") {
      const reply = await sfu.call("POST", "/admin/reload-stores");
      if (reply.status !== 200) flag(`reload answered ${reply.status}`);
    } else if (kind === "restart") {
      await stopSfu(sfu);
      sfus[sfu.name] = await startSfu(sfu.name);
    } else {
      const other = observers.scheduling();
      const stored = before.hours.get(profileId);
      await other.importIfNewer({
        kind: "availability",
        id: profileId,
        clientId: "conclave",
        updatedAt: LEGACY_STAMP + 1,
        payload: { profileId, availability: { timeZone, windows: stored?.windows ?? LEGACY_WINDOWS, overrides: [RECOVERED_OVERRIDE], updatedAt: LEGACY_STAMP + 1 } },
      });
      await other.close?.();
    }
    await settle();
    const after = await readStorage();
    if (kind !== "recover hours") {
      const was = JSON.parse(contentOf(before)) as Record<string, unknown>;
      const now = JSON.parse(contentOf(after)) as Record<string, unknown>;
      for (const collection of Object.keys(was)) {
        if (JSON.stringify(was[collection]) !== JSON.stringify(now[collection])) flag(`a ${kind} changed the ${collection} storage holds`);
      }
    }
    if (kind !== "recover hours") {
      const current = sfus[sfu.name]!;
      memoryMatchesStorage(
        current,
        after,
        { meetings: [...after.meetings.keys()], webinars: [...after.webinars.keys()], eventType: true, hours: true },
        `after a ${kind}`,
      );
    }
    gate.auto = false;
  };

  try {
    const legacyProfile = ensureSchedulingProfile(createSchedulingStore(), {
      clientId: "conclave",
      userId: HOST_HEADERS["x-user-id"],
      email: HOST_HEADERS["x-user-email"],
      name: HOST_HEADERS["x-user-name"],
      timeZone,
    });
    legacyProfile.updatedAt = LEGACY_STAMP;
    const seeding = observers.scheduling();
    await seeding.save({
      profiles: [legacyProfile],
      availability: [{ profileId: legacyProfile.id, availability: { timeZone, windows: LEGACY_WINDOWS, overrides: [] } }] as never,
      eventTypes: [],
      calendars: [],
    });
    await seeding.close?.();
    profileId = legacyProfile.id;

    sfus.A = await startSfu("A");
    const profile = (await sfus.A.call("GET", "/scheduling/profile")).body.profile as { id: string; username: string };
    username = profile.username;
    if (profile.id !== profileId) flag("the host's legacy profile was not reused");
    const created = (await sfus.A.call("POST", "/scheduling/event-types", { title: "Intro call", isActive: true, minimumNoticeMinutes: 0 })).body.eventType as { id: string; slug: string };
    eventTypeId = created.id;
    slug = created.slug;
    const offered = (await sfus.A.call("GET", `/scheduling/public/${username}/${slug}/slots`)).body.slots as Array<{ startAt: number }>;
    const tomorrow = offered.filter((slot) => slot.startAt > Date.now() + 86_400_000);
    bookDate = dateIn(timeZone, tomorrow[0].startAt);
    slots = tomorrow.filter((slot) => dateIn(timeZone, slot.startAt) === bookDate).slice(0, 4).map((slot) => slot.startAt);
    sfus.B = await startSfu("B");
    gate.auto = false;

    for (let step = 0; step < STEPS; step += 1) {
      const roll = rand();
      const sfu = sfus[pick<SfuName>(["A", "B"])]!;
      if (roll < 0.08) {
        await exclusive(pick(["reload", "reload", "restart", "recover hours"] as const), sfu);
      } else if (pending.size < MAX_INFLIGHT && (roll < 0.55 || gate.parked.length === 0)) {
        startOp(sfu);
      } else if (gate.parked.length > 0) {
        trace.push(`release ${gate.releaseAt(Math.floor(rand() * gate.parked.length))}`);
      }
      await settle();
      await checkCompleted();
      await checkNoResurrection();
    }

    await quiesce();
    for (const name of ["A", "B"] as const) await exclusive("reload", sfus[name]!);
    for (const name of ["A", "B"] as const) await exclusive("restart", sfus[name]!);
    await checkNoResurrection();
  } finally {
    gate.drain();
    await Promise.allSettled([...pending]);
    for (const close of closers) await close();
  }
  return violations.map((violation) => `[${mode} seed ${seed}] ${violation}`);
};

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6481);
});

afterAll(() => {
  redis?.stop();
});

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-store-model-"));
  vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "600000");
  for (const variable of ["SCHEDULING_EMAIL_WORKER_URL", "REDIS_URL", "SFU_REDIS_URL", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULING_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const modes: Mode[] = hasRedis ? ["sqlite", "json", "redis"] : ["sqlite", "json"];

describe("two SFUs sharing a store, under random interleavings", () => {
  it.each(modes)(
    "in %s mode answer and apply only what storage committed, book only open hours, and never bring back a delete",
    async (mode) => {
      const found: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        found.push(...(await runModel(mode, seed, join(dir, `seed-${seed}`))));
      }
      if (process.env.STORE_MODEL_REPORT) process.stderr.write(`${found.join("\n")}\n`);
      expect(found).toEqual([]);
    },
    600_000,
  );
});
