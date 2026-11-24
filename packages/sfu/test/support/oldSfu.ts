import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient } from "redis";
import { openSqliteDatabase } from "../../server/controlPlane/backends/sqlite.js";

export type OldMode = "sqlite" | "json" | "redis";

export type LegacyMeeting = Record<string, unknown> & { id: string; roomCode: string; updatedAt: number };
export type LegacyWebinar = Record<string, unknown> & { id: string; linkSlug: string; roomId: string; updatedAt: number };
export type LegacyProfile = Record<string, unknown> & { id: string; userId: string; username: string; updatedAt: number };

export const legacyEncrypt = (token: string, secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
};

export const legacyMeeting = (id: string, fields: Record<string, unknown> = {}): LegacyMeeting => ({
  id,
  clientId: "conclave",
  roomCode: `room-${id}`,
  title: `Meeting ${id}`,
  hostEmail: "host@example.test",
  hostName: "Host",
  hostUserId: "host-user",
  scheduledStartAt: 4_000_000_000_000,
  scheduledEndAt: 4_000_003_600_000,
  status: "scheduled",
  startedAt: null,
  endedAt: null,
  createdBy: "host@example.test",
  source: "manual",
  createdAt: 100,
  updatedAt: 100,
  ...fields,
});

export const legacyWebinar = (id: string, fields: Record<string, unknown> = {}): LegacyWebinar => ({
  id,
  clientId: "conclave",
  roomId: `sched-${id}`,
  linkSlug: `webinar-${id}`,
  title: `Webinar ${id}`,
  description: "",
  hostEmail: "host@example.test",
  hostName: "Host",
  hostUserId: "host-user",
  coHosts: [],
  scheduledStartAt: 4_000_000_000_000,
  scheduledEndAt: 4_000_003_600_000,
  status: "scheduled",
  publicAccess: true,
  maxAttendees: 500,
  requiresInviteCode: false,
  waitingRoomEnabled: true,
  earlyEntryMinutes: 10,
  qaEnabled: true,
  notes: "",
  createdAt: 100,
  createdBy: "host@example.test",
  updatedAt: 100,
  liveStartedAt: null,
  endedAt: null,
  totalJoinCount: 0,
  peakAttendeeCount: 0,
  ...fields,
});

export const legacyProfile = (id: string, fields: Record<string, unknown> = {}): LegacyProfile => ({
  id,
  clientId: "conclave",
  userId: `user-${id}`,
  email: `${id}@example.test`,
  name: `Host ${id}`,
  username: `host-${id}`,
  timeZone: "Asia/Kolkata",
  createdAt: 100,
  updatedAt: 100,
  ...fields,
});

export const legacyCalendar = (profileId: string, secret: string, fields: Record<string, unknown> = {}) => ({
  id: `calendar-${profileId}`,
  clientId: "conclave",
  profileId,
  userId: `user-${profileId}`,
  provider: "google",
  status: "connected",
  email: "host@example.test",
  calendarId: "primary",
  accessToken: legacyEncrypt("access-token-value", secret),
  refreshToken: legacyEncrypt("refresh-token-value", secret),
  accessTokenExpiresAt: 1_800_000_000_000,
  scopes: [],
  connectedAt: 100,
  updatedAt: 150,
  error: null,
  ...fields,
});

export type OldSfuPaths = { sqlite: string; jsonDir: string; redisUrl?: string; prefix?: string };

export type LegacyCalendar = ReturnType<typeof legacyCalendar>;

type Snapshot = {
  meetings: Map<string, LegacyMeeting>;
  webinars: Map<string, LegacyWebinar>;
  profiles: Map<string, LegacyProfile>;
  calendars: Map<string, LegacyCalendar>;
};

export type OldSfu = {
  putMeeting: (meeting: LegacyMeeting) => Promise<void>;
  removeMeeting: (id: string) => Promise<void>;
  putWebinar: (webinar: LegacyWebinar) => Promise<void>;
  removeWebinar: (id: string) => Promise<void>;
  putProfile: (profile: LegacyProfile) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  putCalendar: (calendar: LegacyCalendar) => Promise<void>;
  removeCalendar: (profileId: string) => Promise<void>;
  close: () => Promise<void>;
};

const SQLITE_TABLES = `
  CREATE TABLE IF NOT EXISTS scheduled_webinars (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_id TEXT NOT NULL,
    link_slug TEXT NOT NULL, status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL,
    scheduled_end_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scheduled_meetings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_code TEXT NOT NULL,
    status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL, scheduled_end_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scheduling_records (kind TEXT NOT NULL, id TEXT NOT NULL, client_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (kind, id));
`;

const withSqlite = (path: string, run: (db: ReturnType<typeof openSqliteDatabase>) => void): void => {
  const db = openSqliteDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SQLITE_TABLES);
    run(db);
  } finally {
    db.close();
  }
};

const sqliteMeeting = (path: string, meeting: LegacyMeeting) =>
  withSqlite(path, (db) => {
    db.prepare("INSERT OR REPLACE INTO scheduled_meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      meeting.id, String(meeting.clientId), meeting.roomCode, String(meeting.status), Number(meeting.scheduledStartAt),
      Number(meeting.scheduledEndAt), meeting.updatedAt, JSON.stringify(meeting),
    );
  });

const sqliteWebinar = (path: string, webinar: LegacyWebinar) =>
  withSqlite(path, (db) => {
    db.prepare("INSERT OR REPLACE INTO scheduled_webinars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      webinar.id, String(webinar.clientId), webinar.roomId, webinar.linkSlug, String(webinar.status),
      Number(webinar.scheduledStartAt), Number(webinar.scheduledEndAt), webinar.updatedAt, JSON.stringify(webinar),
    );
  });

const sqliteDelete = (path: string, sql: string, ...params: string[]) =>
  withSqlite(path, (db) => {
    db.prepare(sql).run(...params);
  });

const readJsonList = <T>(path: string): T[] => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T[]) : []);

const writeJson = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};

export const jsonPaths = (dir: string) => ({
  meetings: join(dir, "scheduled-meetings.json"),
  webinars: join(dir, "scheduled-webinars.json"),
  scheduling: join(dir, "scheduling.json"),
});

export const writeLegacyJsonFiles = (
  dir: string,
  data: {
    meetings?: unknown[];
    webinars?: unknown[];
    profiles?: unknown[];
    availability?: unknown[];
    eventTypes?: unknown[];
    calendars?: unknown[];
  },
): void => {
  const paths = jsonPaths(dir);
  if (data.meetings) writeJson(paths.meetings, data.meetings);
  if (data.webinars) writeJson(paths.webinars, data.webinars);
  if (data.profiles || data.availability || data.eventTypes || data.calendars) {
    writeJson(paths.scheduling, {
      profiles: data.profiles ?? [],
      availability: data.availability ?? [],
      eventTypes: data.eventTypes ?? [],
      calendars: data.calendars ?? [],
    });
  }
};

const jsonOldSfu = (dir: string): OldSfu => {
  const paths = jsonPaths(dir);
  const snapshot = (): Snapshot => {
    const scheduling = existsSync(paths.scheduling)
      ? (JSON.parse(readFileSync(paths.scheduling, "utf8")) as { profiles?: LegacyProfile[]; calendars?: LegacyCalendar[] })
      : {};
    return {
      meetings: new Map(readJsonList<LegacyMeeting>(paths.meetings).map((entry) => [entry.id, entry])),
      webinars: new Map(readJsonList<LegacyWebinar>(paths.webinars).map((entry) => [entry.id, entry])),
      profiles: new Map((scheduling.profiles ?? []).map((entry) => [entry.id, entry])),
      calendars: new Map((scheduling.calendars ?? []).map((entry) => [entry.profileId, entry])),
    };
  };
  const save = (data: Snapshot) => {
    writeJson(paths.meetings, [...data.meetings.values()]);
    writeJson(paths.webinars, [...data.webinars.values()]);
    writeJson(paths.scheduling, {
      profiles: [...data.profiles.values()],
      availability: [],
      eventTypes: [],
      calendars: [...data.calendars.values()],
    });
  };
  const change = async (edit: (data: Snapshot) => void) => {
    const data = snapshot();
    edit(data);
    save(data);
  };
  return {
    putMeeting: (meeting) => change((data) => void data.meetings.set(meeting.id, meeting)),
    removeMeeting: (id) => change((data) => void data.meetings.delete(id)),
    putWebinar: (webinar) => change((data) => void data.webinars.set(webinar.id, webinar)),
    removeWebinar: (id) => change((data) => void data.webinars.delete(id)),
    putProfile: (profile) => change((data) => void data.profiles.set(profile.id, profile)),
    removeProfile: (id) => change((data) => void data.profiles.delete(id)),
    putCalendar: (calendar) => change((data) => void data.calendars.set(calendar.profileId, calendar)),
    removeCalendar: (profileId) => change((data) => void data.calendars.delete(profileId)),
    close: async () => {},
  };
};

const sqliteOldSfu = (path: string): OldSfu => ({
  putMeeting: async (meeting) => sqliteMeeting(path, meeting),
  removeMeeting: async (id) => sqliteDelete(path, "DELETE FROM scheduled_meetings WHERE id = ?", id),
  putWebinar: async (webinar) => sqliteWebinar(path, webinar),
  removeWebinar: async (id) => sqliteDelete(path, "DELETE FROM scheduled_webinars WHERE id = ?", id),
  putProfile: async (profile) =>
    withSqlite(path, (db) => {
      db.prepare("INSERT OR REPLACE INTO scheduling_records VALUES (?, ?, ?, ?, ?)").run(
        "profile", profile.id, "conclave", profile.updatedAt, JSON.stringify(profile),
      );
    }),
  removeProfile: async (id) => sqliteDelete(path, "DELETE FROM scheduling_records WHERE kind = 'profile' AND id = ?", id),
  putCalendar: async (calendar) =>
    withSqlite(path, (db) => {
      db.prepare("INSERT OR REPLACE INTO scheduling_records VALUES (?, ?, ?, ?, ?)").run(
        "calendar", calendar.profileId, "conclave", calendar.updatedAt, JSON.stringify(calendar),
      );
    }),
  removeCalendar: async (profileId) =>
    sqliteDelete(path, "DELETE FROM scheduling_records WHERE kind = 'calendar' AND id = ?", profileId),
  close: async () => {},
});

const redisOldSfu = async (paths: OldSfuPaths): Promise<OldSfu> => {
  const client = createClient({ url: paths.redisUrl });
  await client.connect();
  const prefix = String(paths.prefix);
  const wrapped = (record: { updatedAt: number }) => JSON.stringify({ updatedAt: record.updatedAt, payload: record });
  return {
    putMeeting: async (meeting) => {
      await client.hSet(`${prefix}:scheduled-meetings`, meeting.id, JSON.stringify(meeting));
    },
    removeMeeting: async (id) => {
      await client.hDel(`${prefix}:scheduled-meetings`, id);
    },
    putWebinar: async (webinar) => sqliteWebinar(paths.sqlite, webinar),
    removeWebinar: async (id) => sqliteDelete(paths.sqlite, "DELETE FROM scheduled_webinars WHERE id = ?", id),
    putProfile: async (profile) => {
      await client.hSet(`${prefix}:scheduling:profiles`, profile.id, wrapped(profile));
    },
    removeProfile: async (id) => {
      await client.hDel(`${prefix}:scheduling:profiles`, id);
      await client.hSet(`${prefix}:scheduling:tombstones`, `profile:${id}`, String(Date.now()));
    },
    putCalendar: async (calendar) => {
      await client.hSet(`${prefix}:scheduling:calendars`, calendar.profileId, wrapped(calendar));
    },
    removeCalendar: async (profileId) => {
      await client.hDel(`${prefix}:scheduling:calendars`, profileId);
    },
    close: async () => {
      await client.quit();
    },
  };
};

export const startOldSfu = (mode: OldMode, paths: OldSfuPaths): Promise<OldSfu> =>
  mode === "redis" ? redisOldSfu(paths) : Promise.resolve(mode === "json" ? jsonOldSfu(paths.jsonDir) : sqliteOldSfu(paths.sqlite));
