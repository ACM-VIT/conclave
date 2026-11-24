import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoreMode } from "../../server/controlPlane/backends/backend.js";
import { createMemoryData } from "../../server/controlPlane/backends/memory.js";
import { advanceMeetings } from "../../server/controlPlane/meetingCommands.js";
import { isActiveMeeting, type EntityMap, type Kind } from "../../server/controlPlane/model.js";
import { BOOKING_GONE } from "../../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../../server/controlPlane/store.js";
import { advanceScheduledWebinars } from "../../server/scheduledWebinarScheduler.js";
import {
  bookingBlocksInterval,
  generateAvailableSlots,
  internalBusyIntervals,
} from "../../server/scheduling.js";
import { sendDueSchedulingEmailReminders } from "../../server/schedulingEmailReminders.js";
import type { ScheduledMeeting } from "../../types.js";
import { startRedisProxy, type RedisProxy } from "./redisProxy.js";
import { hasRedis, startRedis, type RedisServer } from "./redisServer.js";
import {
  EMAIL_WORKER_URL,
  FakeEmail,
  FakeGoogle,
  Gates,
  installFakeFetch,
  openWorldStore,
  runAsOp,
  startSfu,
  stopSfu,
  type CommitEntry,
  type GateKind,
  type Op,
  type Reply,
  type Sfu,
  type SfuName,
  type WorldOptions,
} from "./twoSfuWorld.js";

const SEEDS = Number(process.env.CONTROL_PLANE_MODEL_SEEDS ?? 20);
const SEED_FROM = Number(process.env.CONTROL_PLANE_MODEL_SEED_FROM ?? 1);
const STEPS = Number(process.env.CONTROL_PLANE_MODEL_STEPS ?? 36);
const MODES = (process.env.CONTROL_PLANE_MODEL_MODES ?? "memory,sqlite,redis")
  .split(",")
  .map((mode) => mode.trim())
  .filter((mode) => mode !== "redis" || hasRedis) as StoreMode[];
const MAX_INFLIGHT = 4;
const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const DAY_MS = 86_400_000;

let redis: RedisServer | null = null;
let google: FakeGoogle | null = null;
let email: FakeEmail | null = null;
let restoreFetch: () => void = () => {};

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

const key = (kind: Kind, id: string) => `${kind}:${id}`;

const DERIVED: Partial<Record<Kind, string[]>> = {
  eventType: ["updatedAt"],
  profile: ["updatedAt", "timeZone"],
  meeting: ["updatedAt", "startedAt", "endedAt"],
  webinar: ["updatedAt", "liveStartedAt", "endedAt", "webinarLink"],
  calendar: ["updatedAt"],
};

const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );

type Intent = { kind: Kind; fields: string[] };

type Completed = { op: Op; reply: Reply | null; intent: Intent | null; target?: string };

const runSequence = async (mode: StoreMode, seed: number, steps: number): Promise<string[]> => {
  const dir = mkdtempSync(join(tmpdir(), "sfu-cp-model-"));
  const rand = random(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const violations: string[] = [];
  const trace: string[] = [];
  const flag = (message: string) => {
    if (!violations.some((entry) => entry.startsWith(message))) {
      violations.push(process.env.CONTROL_PLANE_MODEL_TRACE ? `${message}\n    ${trace.slice(-12).join(" / ")}` : message);
    }
  };
  const gates = new Gates();
  google = new FakeGoogle(gates);
  email = new FakeEmail(gates);
  const log: CommitEntry[] = [];
  const realStart = Date.now();
  let advance = 0;
  const skew: Record<SfuName, number> = { A: 0, B: Math.floor((rand() - 0.5) * 180_000) };
  const world: WorldOptions = {
    mode,
    dir,
    redisUrl: redis?.url,
    prefix: `model:${mode}:${seed}:${realStart}:${Math.random()}`,
    clock: (sfu) => Date.now() + advance + skew[sfu],
    memory: createMemoryData(),
  };
  const proxies: RedisProxy[] = [];
  if (mode === "redis" && redis) {
    const network = random(seed ^ 0x9e3779b9);
    const target = { host: "127.0.0.1", port: redis.port };
    for (const sfu of ["A", "B"] as const) {
      proxies.push(
        await startRedisProxy(target, {
          label: sfu,
          gates,
          jitter: () => Math.floor(network() * 3),
          park: () => network() < 0.15,
        }),
      );
    }
    world.redisUrlFor = (sfu) => (sfu === "B" ? proxies[1].url : sfu === "A" ? proxies[0].url : redis!.url);
  }
  const sfus: Record<SfuName, Sfu | null> = { A: null, B: null };
  let observer: ControlPlaneStore | null = null;
  const pending = new Set<Promise<void>>();
  const completed: Completed[] = [];
  const checkedRevs = new Set<number>();
  let opCounter = 0;
  const meetingIds: string[] = [];
  const webinarIds: string[] = [];
  let eventTypeId = "";
  let username = "";
  const bookDay = new Date(Date.UTC(new Date(realStart).getUTCFullYear(), new Date(realStart).getUTCMonth(), new Date(realStart).getUTCDate() + 3));
  const bookDate = bookDay.toISOString().slice(0, 10);
  const slots = [10, 10.5, 11, 11.5, 12].map((hour) => bookDay.getTime() + hour * 3_600_000);
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));

  const newOp = (sfu: SfuName, label: string, method: string): Op => ({
    id: `op-${(opCounter += 1)}`,
    label,
    sfu,
    method,
  });

  const launch = (sfu: Sfu, label: string, method: string, intent: Intent | null, run: (op: Op) => Promise<Reply | null>, target?: string) => {
    const op = newOp(sfu.name, label, method);
    trace.push(`${sfu.name} ${label}${target ? ` ${target.slice(0, 8)}` : ""}`);
    const task = run(op)
      .then((reply) => {
        completed.push({ op, reply, intent, target });
        trace.push(`${sfu.name} ${label} -> ${reply?.status ?? "-"}`);
        const body = reply?.body ?? {};
        const created = (body.scheduledMeeting ?? body.booking) as { id?: string } | undefined;
        if (reply && reply.status < 300 && created?.id && !meetingIds.includes(created.id)) meetingIds.push(created.id);
        const webinar = body.scheduledWebinar as { id?: string } | undefined;
        if (reply && reply.status < 300 && webinar?.id && !webinarIds.includes(webinar.id)) webinarIds.push(webinar.id);
      })
      .catch((error: unknown) => flag(`${label} threw ${(error as Error).message}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const history = () => {
    const versions = new Map<string, Array<{ rev: number; value: EntityMap[Kind] | null; entry: CommitEntry }>>();
    for (const entry of [...log].sort((a, b) => a.rev - b.rev)) {
      for (const write of entry.writes) {
        const list = versions.get(key(write.kind, write.id)) ?? [];
        list.push({ rev: entry.rev, value: write.value, entry });
        versions.set(key(write.kind, write.id), list);
      }
    }
    return versions;
  };

  const valueAt = (versions: ReturnType<typeof history>, kind: Kind, id: string, rev: number) => {
    const list = versions.get(key(kind, id)) ?? [];
    let value: EntityMap[Kind] | null = null;
    for (const version of list) {
      if (version.rev < rev) value = version.value;
      else break;
    }
    return value;
  };

  const stateAt = <K extends Kind>(versions: ReturnType<typeof history>, kind: K, rev: number): Array<EntityMap[K]> => {
    const result: Array<EntityMap[K]> = [];
    for (const [entryKey, list] of versions) {
      if (!entryKey.startsWith(`${kind}:`)) continue;
      let value: EntityMap[Kind] | null = null;
      for (const version of list) if (version.rev < rev) value = version.value;
      if (value) result.push(value as EntityMap[K]);
    }
    return result;
  };

  const checkHistory = () => {
    const versions = history();
    const seenRevs = new Set<number>();
    for (const entry of log) {
      if (seenRevs.has(entry.rev)) flag(`two commits share revision ${entry.rev}`);
      seenRevs.add(entry.rev);
    }
    for (const [entryKey, list] of versions) {
      if (!entryKey.startsWith("calendar:") && !entryKey.startsWith("hours:")) {
        let removed = false;
        for (const version of list) {
          if (version.value === null) removed = true;
          else if (removed) flag(`${entryKey} came back after it was deleted (${version.entry.op?.label})`);
        }
      }
      for (let index = 0; index < list.length; index += 1) {
        const version = list[index];
        if (checkedRevs.has(version.rev)) continue;
        const previous = index > 0 ? list[index - 1].value : null;
        const label = version.entry.op?.label ?? "background";
        if (label === "setup") continue;
        const kind = entryKey.split(":")[0] as Kind;
        if (!previous || !version.value) continue;
        const changed = changedFields(previous as never, version.value as never);
        const allowed = new Set([...(DERIVED[kind] ?? []), ...allowedFor(label, kind)]);
        const extra = changed.filter((field) => !allowed.has(field));
        if (extra.length > 0) {
          flag(`${label} changed ${kind} fields it does not own (${extra.join(", ")}): a lost update`);
        }
      }
    }
    for (const entry of log) {
      if (checkedRevs.has(entry.rev)) continue;
      checkBooking(versions, entry);
    }
    for (const entry of log) checkedRevs.add(entry.rev);
  };

  const ownedFields: Record<string, Partial<Record<Kind, string[]>>> = {
    "edit event type title": { eventType: ["title"] },
    "edit event type duration": { eventType: ["durationMinutes"] },
    "toggle event type": { eventType: ["isActive"] },
    "edit event type buffer": { eventType: ["bufferAfterMinutes"] },
    "close day": { hours: ["availability"], profile: [] },
    "open day": { hours: ["availability"], profile: [] },
    "rename host": { profile: ["name"] },
    book: {
      meeting: ["googleCalendarEventId", "calendarSyncStatus", "calendarSyncError", "emailNotificationStatus", "emailNotificationError", "emailNotificationSentAt"],
    },
    "connect calendar": { calendar: ["accessToken", "refreshToken", "accessTokenExpiresAt", "scopes", "grantId", "status", "error", "email"] },
    "edit meeting title": { meeting: ["title"] },
    "start meeting": { meeting: ["status"] },
    "cancel meeting": { meeting: ["status"] },
    "edit webinar title": { webinar: ["title"] },
    "edit webinar slug": { webinar: ["linkSlug"] },
    "co-host invite": { webinar: ["coHostInviteTokenHash", "coHostInviteTokenCreatedAt"] },
    "accept co-host invite": { webinar: ["coHosts"] },
    tick: {
      meeting: ["status", "emailReminderStatus", "emailReminderError", "emailReminderSentAt"],
      webinar: ["status"],
    },
  };
  const allowedFor = (label: string, kind: Kind): string[] => ownedFields[label]?.[kind] ?? [];

  const checkBooking = (versions: ReturnType<typeof history>, entry: CommitEntry) => {
    if (entry.op?.label !== "book") return;
    for (const write of entry.writes) {
      if (write.kind !== "meeting" || !write.value) continue;
      if (valueAt(versions, "meeting", write.id, entry.rev) !== null) continue;
      const meeting = write.value as ScheduledMeeting;
      const eventType = valueAt(versions, "eventType", meeting.eventTypeId ?? "", entry.rev) as EntityMap["eventType"] | null;
      const profile = stateAt(versions, "profile", entry.rev)[0];
      const hours = profile ? (valueAt(versions, "hours", profile.id, entry.rev) as EntityMap["hours"] | null) : null;
      if (!eventType || !eventType.isActive) {
        flag("a booking committed on an event type that was off or gone");
        continue;
      }
      if (!profile || !hours) {
        flag("a booking committed without committed hours");
        continue;
      }
      const others = stateAt(versions, "meeting", entry.rev).filter((other) => other.id !== meeting.id && isActiveMeeting(other));
      const eventTypes = new Map(stateAt(versions, "eventType", entry.rev).map((other) => [other.id, other]));
      const blocked = bookingBlocksInterval(eventType, meeting.scheduledStartAt, meeting.scheduledEndAt);
      if (internalBusyIntervals(others, (id) => eventTypes.get(id) ?? null, profile, blocked.startAt, blocked.endAt).length > 0) {
        flag("two committed bookings overlap");
      }
      const offered = generateAvailableSlots({
        eventType,
        availability: hours.availability,
        busyIntervals: [],
        from: meeting.scheduledStartAt - 60_000,
        to: meeting.scheduledEndAt + 60_000,
        now: meeting.scheduledStartAt - DAY_MS,
        timeZone: profile.timeZone,
      }).some((slot) => slot.startAt === meeting.scheduledStartAt && slot.endAt === meeting.scheduledEndAt);
      if (!offered) flag("a booking committed outside the hours committed at that moment");
    }
  };

  const checkCompleted = () => {
    for (const done of completed.splice(0)) {
      const { op, reply } = done;
      const entries = log.filter((entry) => entry.op?.id === op.id);
      if (!reply) continue;
      const ok = reply.status >= 200 && reply.status < 300;
      if (op.method === "GET" && entries.length > 0) flag(`${op.label} (a GET) wrote ${entries[0].writes.map((w) => w.kind).join(",")}`);
      if (!ok && entries.length > 0) {
        const gone = reply.body.error === BOOKING_GONE;
        if (!gone) flag(`${op.label} answered ${reply.status} but committed a change`);
      }
      if (!ok) continue;
      const lastWrite = (kind: Kind, id: string) => {
        for (const entry of [...entries].sort((a, b) => b.rev - a.rev)) {
          const write = entry.writes.find((w) => w.kind === kind && w.id === id);
          if (write) return write;
        }
        return undefined;
      };
      const body = reply.body;
      const expectSame = (kind: Kind, returned: unknown, strip: string[] = []) => {
        const id = (returned as { id?: string } | undefined)?.id;
        if (!id) return;
        const write = lastWrite(kind, id);
        if (!write) return;
        const committed = { ...(write.value as Record<string, unknown>) };
        const answered = { ...(returned as Record<string, unknown>) };
        for (const field of strip) {
          delete committed[field];
          delete answered[field];
        }
        if (JSON.stringify(committed) !== JSON.stringify(answered)) {
          flag(`${op.label} answered ${reply.status} with a ${kind} that differs from what it committed`);
        }
      };
      if (body.eventType) expectSame("eventType", body.eventType);
      if (body.scheduledMeeting) expectSame("meeting", body.scheduledMeeting);
      if (body.scheduledWebinar) expectSame("webinar", body.scheduledWebinar, ["coHostInviteTokenHash", "coHostInviteTokenCreatedAt", "inviteCodeHash"]);
      if (op.label === "close day" || op.label === "open day") {
        const write = entries.flatMap((entry) => entry.writes).find((w) => w.kind === "hours");
        if (write && JSON.stringify((write.value as EntityMap["hours"]).availability) !== JSON.stringify(body.availability)) {
          flag(`${op.label} answered with hours it did not commit`);
        }
      }
      if (op.label === "book" && reply.status === 201) {
        const booking = body.booking as { id: string; startsAt: number; syncStatus: string; emailNotificationStatus: string; calendarEventId: string | null };
        const write = lastWrite("meeting", booking.id);
        const meeting = write?.value as ScheduledMeeting | undefined;
        if (!meeting) flag("a booking answered 201 that this request never committed");
        else if (
          meeting.scheduledStartAt !== booking.startsAt ||
          meeting.calendarSyncStatus !== booking.syncStatus ||
          meeting.emailNotificationStatus !== booking.emailNotificationStatus ||
          (meeting.googleCalendarEventId ?? null) !== booking.calendarEventId
        ) {
          flag("a booking answered 201 with details it did not commit");
        }
      }
      if (op.method === "DELETE" && done.target) {
        const removed = entries.some((entry) => entry.writes.some((w) => w.id === done.target && w.value === null));
        if (!removed) flag(`${op.label} answered ${reply.status} but deleted nothing`);
      }
    }
  };

  const checkAuthority = async () => {
    if (!observer) return;
    const snapshot = await observer.read((view) => ({
      profiles: view.all("profile"),
      eventTypes: view.all("eventType"),
      meetings: view.all("meeting"),
      webinars: view.all("webinar"),
    }));
    const versions = history();
    const latest = (kind: Kind, id: string) => {
      const list = versions.get(key(kind, id)) ?? [];
      return list[list.length - 1];
    };
    for (const [kind, records] of [
      ["profile", snapshot.profiles],
      ["eventType", snapshot.eventTypes],
      ["meeting", snapshot.meetings],
      ["webinar", snapshot.webinars],
    ] as const) {
      for (const stored of records) {
        const last = latest(kind, (stored.value as { id: string }).id);
        if (!last || last.rev !== stored.rev || JSON.stringify(last.value) !== JSON.stringify(stored.value)) {
          flag(`storage holds a ${kind} that no logged commit wrote`);
        }
      }
    }
    const unique = (label: string, keys: string[]) => {
      if (new Set(keys).size !== keys.length) flag(`${label} is not unique`);
    };
    unique("(clientId, userId)", snapshot.profiles.map((p) => `${p.value.clientId}:${p.value.userId}`));
    unique("(clientId, username)", snapshot.profiles.map((p) => `${p.value.clientId}:${p.value.username}`));
    unique("(profileId, slug)", snapshot.eventTypes.map((e) => `${e.value.profileId}:${e.value.slug}`));
    unique("active (clientId, roomCode)", snapshot.meetings.filter((m) => isActiveMeeting(m.value)).map((m) => `${m.value.clientId}:${m.value.roomCode}`));
    unique("linkSlug", snapshot.webinars.map((w) => w.value.linkSlug));
    const reminders = new Map<string, number>();
    for (const sent of email?.sent ?? []) {
      if (sent.type === "booking-reminder" || sent.type.includes("reminder")) {
        reminders.set(`${sent.meetingId}:${sent.to}`, (reminders.get(`${sent.meetingId}:${sent.to}`) ?? 0) + 1);
      }
    }
    for (const [target, count] of reminders) if (count > 1) flag(`a reminder went out ${count} times (${target.split(":")[0].slice(0, 8)})`);
    const recordedEvents = new Set(
      [...versions.values()].flatMap((list) =>
        list.map((version) => (version.value as { googleCalendarEventId?: string | null } | null)?.googleCalendarEventId),
      ),
    );
    for (const event of google?.events.values() ?? []) {
      if (!recordedEvents.has(event.id)) flag("a Google event outlived the booking it was made for");
    }
  };

  const settle = async () => {
    let last = "";
    let stable = 0;
    for (let round = 0; round < 400 && stable < 3; round += 1) {
      await sleep(1);
      const signature = `${gates.parked.length}:${completed.length}:${pending.size}:${log.length}`;
      stable = signature === last ? stable + 1 : 0;
      last = signature;
    }
  };

  const drain = async () => {
    for (let round = 0; round < 400 && (pending.size > 0 || gates.parked.length > 0); round += 1) {
      if (gates.parked.length > 0) trace.push(`release ${gates.releaseAt(0)}`);
      await settle();
    }
    if (pending.size > 0) flag(`an operation never finished (${trace.at(-1)})`);
  };

  const host = (sfu: Sfu, op: Op, path: string, body?: unknown) => sfu.call(op, path, body, HOST);

  const startOp = (sfu: Sfu) => {
    const choices: Array<() => void> = [
      () => launch(sfu, "edit event type title", "PATCH", null, (op) => host(sfu, op, `/scheduling/event-types/${eventTypeId}`, { title: `Intro ${Math.floor(rand() * 1e6)}` })),
      () => launch(sfu, "edit event type duration", "PATCH", null, (op) => host(sfu, op, `/scheduling/event-types/${eventTypeId}`, { durationMinutes: pick([30, 60]) })),
      () => launch(sfu, "toggle event type", "PATCH", null, (op) => host(sfu, op, `/scheduling/event-types/${eventTypeId}`, { isActive: rand() < 0.75 })),
      () => launch(sfu, "edit event type buffer", "PATCH", null, (op) => host(sfu, op, `/scheduling/event-types/${eventTypeId}`, { bufferAfterMinutes: pick([0, 30]) })),
      () => {
        const close = rand() < 0.5;
        launch(sfu, close ? "close day" : "open day", "PUT", null, (op) =>
          host(sfu, op, "/scheduling/availability/default", {
            timeZone: "UTC",
            windows: allDay,
            overrides: close ? [{ date: bookDate, unavailable: true, windows: [] }] : [],
          }),
        );
      },
      () => launch(sfu, "rename host", "PUT", null, (op) => host(sfu, op, "/scheduling/profile", { name: `Host ${Math.floor(rand() * 1000)}` })),
      () =>
        launch(sfu, "book", "POST", null, (op) =>
          sfu.call(op, `/scheduling/public/${username}/intro/book`, {
            startAt: pick(slots),
            attendeeName: "Guest",
            attendeeEmail: `guest-${Math.floor(rand() * 1000)}@example.test`,
          }),
        ),
      () =>
        launch(sfu, "book", "POST", null, (op) =>
          sfu.call(op, `/scheduling/public/${username}/intro/book`, {
            startAt: pick(slots),
            attendeeName: "Guest",
            attendeeEmail: `guest-${Math.floor(rand() * 1000)}@example.test`,
          }),
        ),
      () => {
        if (rand() < 0.5) {
          launch(sfu, "connect calendar", "POST", null, (op) =>
            host(sfu, op, "/scheduling/calendar/google", {
              refreshToken: `refresh-${Math.floor(rand() * 1e6)}`,
              accessToken: "stale",
              accessTokenExpiresAt: 1,
            }),
          );
        } else {
          launch(sfu, "disconnect calendar", "DELETE", null, (op) => host(sfu, op, "/scheduling/calendar/google"));
        }
      },
      () =>
        launch(sfu, "create meeting", "POST", null, (op) =>
          host(sfu, op, "/scheduled-meetings", {
            title: `Meeting ${Math.floor(rand() * 1e6)}`,
            scheduledStartAt: world.clock(sfu.name) + pick([-60_000, 30_000, 3_600_000, DAY_MS]),
            scheduledEndAt: world.clock(sfu.name) + pick([60_000, 2 * 3_600_000, 2 * DAY_MS]),
            ...(rand() < 0.4 ? { roomCode: "team-sync" } : {}),
          }),
        ),
      () => {
        if (meetingIds.length === 0) return;
        const id = pick(meetingIds.slice(-5));
        const action = pick(["edit meeting title", "start meeting", "cancel meeting", "delete meeting"] as const);
        const path = action === "start meeting" ? `/scheduled-meetings/${id}/start` : action === "cancel meeting" ? `/scheduled-meetings/${id}/cancel` : `/scheduled-meetings/${id}`;
        const method = action === "edit meeting title" ? "PATCH" : action === "delete meeting" ? "DELETE" : "POST";
        launch(sfu, action, method, null, (op) => host(sfu, op, path, action === "edit meeting title" ? { title: `Renamed ${Math.floor(rand() * 1e6)}` } : undefined), id);
      },
      () =>
        launch(sfu, "create webinar", "POST", null, (op) =>
          host(sfu, op, "/scheduled-webinars", {
            title: `Webinar ${Math.floor(rand() * 1e6)}`,
            scheduledStartAt: world.clock(sfu.name) + pick([-60_000, 3_600_000]),
            ...(rand() < 0.4 ? { linkSlug: "launch-day" } : {}),
          }),
        ),
      () => {
        if (webinarIds.length === 0) return;
        const id = pick(webinarIds.slice(-4));
        const action = pick(["edit webinar title", "edit webinar slug", "delete webinar", "co-host invite"] as const);
        if (action === "co-host invite") {
          launch(sfu, action, "POST", null, async (op) => {
            const invite = await host(sfu, op, `/scheduled-webinars/${id}/cohost-invite`);
            const link = invite.body.coHostInviteLink as string | undefined;
            if (invite.status !== 200 || !link) return invite;
            const token = decodeURIComponent(link.split("/").pop() ?? "");
            const other = sfus[sfu.name === "A" ? "B" : "A"]!;
            launch(other, "accept co-host invite", "POST", null, (acceptOp) =>
              other.call(acceptOp, `/scheduled-webinars/cohost-invites/${encodeURIComponent(token)}/accept`, undefined, {
                "x-user-id": "cohost",
                "x-user-email": "cohost@example.test",
              }),
            );
            return invite;
          }, id);
          return;
        }
        const method = action === "delete webinar" ? "DELETE" : "PATCH";
        const body = action === "edit webinar title" ? { title: `Renamed ${Math.floor(rand() * 1e6)}` } : action === "edit webinar slug" ? { linkSlug: pick(["launch-day", "other-day"]) } : undefined;
        launch(sfu, action, method, null, (op) => host(sfu, op, `/scheduled-webinars/${id}`, body), id);
      },
      () => {
        const path = pick([
          "/scheduling/profile",
          "/scheduling/bookings",
          "/scheduling/event-types",
          "/scheduled-meetings",
          "/scheduled-webinars",
          `/scheduling/public/${username}/intro`,
          `/scheduling/public/${username}/intro/slots?from=${slots[0] - 3_600_000}&to=${slots[4] + 3_600_000}`,
        ]);
        launch(sfu, `read ${path.split("?")[0]}`, "GET", null, (op) => host(sfu, op, path));
      },
      () =>
        launch(sfu, "tick", "TICK", null, (op) =>
          runAsOp(op, async () => {
            await sfu.state.controlPlane.commit(advanceMeetings);
            await advanceScheduledWebinars(sfu.state);
            await sendDueSchedulingEmailReminders(sfu.state);
            return { status: 200, body: {} };
          }),
        ),
    ];
    pick(choices)();
  };

  try {
    sfus.A = await startSfu("A", world, log, gates);
    sfus.B = await startSfu("B", world, log, gates);
    observer = await openWorldStore(world, "observer");
    const setup = sfus.A;
    const op = (label: string, method: string) => newOp("A", label, method);
    const profile = await host(setup, op("setup", "GET"), "/scheduling/profile");
    username = (profile.body.profile as { username: string }).username;
    await host(setup, op("setup", "PUT"), "/scheduling/availability/default", { timeZone: "UTC", windows: allDay, overrides: [] });
    await host(setup, op("setup", "PUT"), "/scheduling/profile", { timeZone: "UTC" });
    const created = await host(setup, op("setup", "POST"), "/scheduling/event-types", {
      title: "Intro",
      slug: "intro",
      isActive: true,
      minimumNoticeMinutes: 0,
      bookingWindowDays: 60,
      durationMinutes: 30,
    });
    eventTypeId = (created.body.eventType as { id: string }).id;
    const kinds: GateKind[] = ["commit", "freebusy", "google-create", "email", ...(mode === "redis" ? (["redis"] as const) : [])];
    for (const kind of kinds) if (rand() < 0.6) gates.parking.add(kind);

    for (let step = 0; step < steps; step += 1) {
      const roll = rand();
      const sfu = sfus[pick<SfuName>(["A", "B"])]!;
      if (roll < 0.04) {
        await drain();
        checkCompleted();
        checkHistory();
        await checkAuthority();
        trace.push(`restart ${sfu.name}`);
        const parking = new Set(gates.parking);
        gates.parking.clear();
        await stopSfu(sfu);
        sfus[sfu.name] = await startSfu(sfu.name, world, log, gates);
        gates.parking = parking;
      } else if (roll < 0.1) {
        advance += pick([60_000, 3_600_000, DAY_MS, 2 * DAY_MS]);
        trace.push(`clock +${advance}`);
      } else if (pending.size < MAX_INFLIGHT && (roll < 0.6 || gates.parked.length === 0)) {
        startOp(sfu);
      } else if (gates.parked.length > 0) {
        trace.push(`release ${gates.releaseAt(Math.floor(rand() * gates.parked.length))}`);
      }
      await settle();
      checkCompleted();
      checkHistory();
    }
    gates.parking.clear();
    await drain();
    checkCompleted();
    checkHistory();
    await checkAuthority();
  } finally {
    gates.drain();
    await Promise.allSettled([...pending]);
    for (const sfu of [sfus.A, sfus.B]) if (sfu) await stopSfu(sfu);
    await observer?.close();
    for (const proxy of proxies) await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return violations;
};

const shrink = async (mode: StoreMode, seed: number, steps: number): Promise<number> => {
  let low = 0;
  let high = steps;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await runSequence(mode, seed, middle)).length > 0) high = middle;
    else low = middle;
  }
  return high;
};

export const describeModel = (only: StoreMode): void => {
  const modes = MODES.filter((mode) => mode === only);

  beforeAll(async () => {
    if (only === "redis" && modes.length > 0) redis = await startRedis(Number(process.env.CONTROL_PLANE_MODEL_REDIS_PORT ?? 6640));
    restoreFetch = installFakeFetch(() => google, () => email);
    vi.stubEnv("GOOGLE_CLIENT_ID", "model-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "model-secret");
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER_URL);
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "model-email-secret");
    vi.stubEnv("SCHEDULING_EMAIL_TIMEOUT_MS", "600000");
    vi.stubEnv("SCHEDULING_EMAIL_REMINDER_MINUTES", "1440");
    vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "600000");
    for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) vi.stubEnv(variable, "");
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterAll(() => {
    restoreFetch();
    redis?.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe.skipIf(modes.length === 0)("two SFUs sharing one control-plane store, under seeded random interleavings", () => {
    it(
      `in ${only} mode answer only what was committed, book only open hours, and never lose, revert or resurrect a write`,
      async () => {
        const found: string[] = [];
        for (let seed = SEED_FROM; seed < SEED_FROM + SEEDS; seed += 1) {
          const violations = await runSequence(only, seed, STEPS);
          if (violations.length === 0) continue;
          const minimal = process.env.CONTROL_PLANE_MODEL_SHRINK === "0" ? STEPS : await shrink(only, seed, STEPS);
          found.push(...violations.map((violation) => `[${only} seed ${seed}, ${minimal} steps] ${violation}`));
        }
        if (process.env.CONTROL_PLANE_MODEL_REPORT) process.stderr.write(`${only}: ${SEEDS} sequences, ${found.length} violations\n${found.join("\n")}\n`);
        expect(found).toEqual([]);
      },
      Number(process.env.CONTROL_PLANE_MODEL_TIMEOUT_MS ?? 3_600_000),
    );
  });
};
