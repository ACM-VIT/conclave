import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  CreateScheduledWebinarRequest,
  ScheduledWebinar,
  ScheduledWebinarCoHost,
  ScheduledWebinarStatus,
  UpdateScheduledWebinarRequest,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  DEFAULT_WEBINAR_MAX_ATTENDEES,
  MAX_WEBINAR_MAX_ATTENDEES,
  MIN_WEBINAR_MAX_ATTENDEES,
  getWebinarBaseUrl,
  hashWebinarInviteCode,
  normalizeWebinarLinkSlug,
  normalizeHostEmail,
} from "./webinar.js";

const DEFAULT_EARLY_ENTRY_MINUTES = 10;
const MAX_EARLY_ENTRY_MINUTES = 240;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const MIN_TITLE_LENGTH = 1;
const MAX_TITLE_LENGTH = 140;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_NOTES_LENGTH = 4_000;
const MAX_CO_HOSTS = 25;

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const RANDOM_SLUG_LENGTH = 8;

const sanitizeString = (
  value: string | undefined,
  options: { max: number; allowEmpty?: boolean } = { max: 0 },
): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!options.allowEmpty && !normalized) {
    return "";
  }
  return normalized.length > options.max
    ? normalized.slice(0, options.max)
    : normalized;
};

const sanitizeBoolean = (
  value: unknown,
  fallback: boolean,
): boolean => (typeof value === "boolean" ? value : fallback);

const sanitizeMaxAttendees = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return Math.max(
    MIN_WEBINAR_MAX_ATTENDEES,
    Math.min(MAX_WEBINAR_MAX_ATTENDEES, normalized),
  );
};

const sanitizeEarlyEntry = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_EARLY_ENTRY_MINUTES, Math.floor(value)));
};

const sanitizeCoHosts = (
  value: ScheduledWebinarCoHost[] | undefined,
): ScheduledWebinarCoHost[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ScheduledWebinarCoHost[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const email = normalizeHostEmail(String(entry.email ?? ""));
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const name = sanitizeString(entry.name, { max: 120, allowEmpty: true });
    result.push({ email, name: name || undefined });
    if (result.length >= MAX_CO_HOSTS) break;
  }
  return result;
};

const generateRandomSlug = (): string => {
  const bytes = randomBytes(RANDOM_SLUG_LENGTH);
  let out = "";
  for (let i = 0; i < RANDOM_SLUG_LENGTH; i += 1) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
};

const generateRoomId = (): string => {
  const bytes = randomBytes(4).toString("hex");
  return `sched-${bytes}`;
};

export type ScheduledWebinarStore = {
  byId: Map<string, ScheduledWebinar>;
  bySlug: Map<string, string>;
  byRoomChannel: Map<string, string>;
};

export const createScheduledWebinarStore = (): ScheduledWebinarStore => ({
  byId: new Map(),
  bySlug: new Map(),
  byRoomChannel: new Map(),
});

const roomChannelKey = (clientId: string, roomId: string): string =>
  `${clientId}:${roomId}`;

const isSlugTaken = (
  store: ScheduledWebinarStore,
  slug: string,
  excludeId?: string,
): boolean => {
  const owner = store.bySlug.get(slug);
  return Boolean(owner && owner !== excludeId);
};

const resolveLinkSlug = (
  store: ScheduledWebinarStore,
  requested: string | undefined,
  excludeId?: string,
): string => {
  if (requested) {
    const normalized = normalizeWebinarLinkSlug(requested);
    if (isSlugTaken(store, normalized, excludeId)) {
      throw new Error("That webinar link code is already in use.");
    }
    return normalized;
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = generateRandomSlug();
    if (!isSlugTaken(store, candidate, excludeId)) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique webinar link.");
};

export const buildWebinarLink = (slug: string): string => {
  const base = getWebinarBaseUrl().replace(/\/$/, "");
  return `${base}/w/${encodeURIComponent(slug)}`;
};

const indexScheduledWebinar = (
  store: ScheduledWebinarStore,
  webinar: ScheduledWebinar,
): void => {
  store.byId.set(webinar.id, webinar);
  store.bySlug.set(webinar.linkSlug, webinar.id);
  store.byRoomChannel.set(
    roomChannelKey(webinar.clientId, webinar.roomId),
    webinar.id,
  );
};

const removeFromIndexes = (
  store: ScheduledWebinarStore,
  webinar: ScheduledWebinar,
): void => {
  store.byId.delete(webinar.id);
  if (store.bySlug.get(webinar.linkSlug) === webinar.id) {
    store.bySlug.delete(webinar.linkSlug);
  }
  const channel = roomChannelKey(webinar.clientId, webinar.roomId);
  if (store.byRoomChannel.get(channel) === webinar.id) {
    store.byRoomChannel.delete(channel);
  }
};

export const getScheduledWebinarById = (
  store: ScheduledWebinarStore,
  id: string,
): ScheduledWebinar | null => store.byId.get(id) ?? null;

export const getScheduledWebinarBySlug = (
  store: ScheduledWebinarStore,
  slug: string,
): ScheduledWebinar | null => {
  const id = store.bySlug.get(slug.trim().toLowerCase());
  return id ? store.byId.get(id) ?? null : null;
};

export const getScheduledWebinarForRoom = (
  store: ScheduledWebinarStore,
  clientId: string,
  roomId: string,
): ScheduledWebinar | null => {
  const id = store.byRoomChannel.get(roomChannelKey(clientId, roomId));
  return id ? store.byId.get(id) ?? null : null;
};

export const listScheduledWebinars = (
  store: ScheduledWebinarStore,
  filter: {
    clientId?: string;
    ownerEmail?: string;
    includeAll?: boolean;
    status?: ScheduledWebinarStatus[];
  } = {},
): ScheduledWebinar[] => {
  const ownerEmail = filter.ownerEmail
    ? normalizeHostEmail(filter.ownerEmail)
    : null;
  const result: ScheduledWebinar[] = [];
  for (const webinar of store.byId.values()) {
    if (filter.clientId && webinar.clientId !== filter.clientId) continue;
    if (
      !filter.includeAll &&
      ownerEmail &&
      webinar.hostEmail !== ownerEmail &&
      !webinar.coHosts.some((entry) => entry.email === ownerEmail)
    ) {
      continue;
    }
    if (filter.status && !filter.status.includes(webinar.status)) {
      continue;
    }
    result.push(webinar);
  }
  return result.sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};

export type ScheduledWebinarPersistence = {
  save: (snapshot: ScheduledWebinar[]) => void;
  load: () => ScheduledWebinar[];
};

const scheduledWebinarsPath = (): string => {
  const configured = process.env.SCHEDULED_WEBINARS_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "scheduled-webinars.json");
};

const writeJsonAtomic = (path: string, data: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
};

export const createFileScheduledWebinarPersistence = (
  path: string = scheduledWebinarsPath(),
): ScheduledWebinarPersistence => ({
  save: (snapshot) => {
    try {
      writeJsonAtomic(path, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      Logger.error("Failed to persist scheduled webinars", error);
    }
  },
  load: () => {
    try {
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .map((entry) => normalizeStoredWebinar(entry))
        .filter((entry): entry is ScheduledWebinar => Boolean(entry));
    } catch (error) {
      Logger.error("Failed to load scheduled webinars", error);
      return [];
    }
  },
});

const normalizeStoredWebinar = (raw: any): ScheduledWebinar | null => {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.linkSlug !== "string" || !raw.linkSlug) return null;
  if (typeof raw.roomId !== "string" || !raw.roomId) return null;
  if (typeof raw.clientId !== "string" || !raw.clientId) return null;
  const status: ScheduledWebinarStatus =
    raw.status === "live" || raw.status === "ended" || raw.status === "cancelled"
      ? raw.status
      : "scheduled";
  const linkSlug = String(raw.linkSlug);
  return {
    id: raw.id,
    clientId: raw.clientId,
    roomId: raw.roomId,
    linkSlug,
    title: sanitizeString(raw.title, { max: MAX_TITLE_LENGTH }) || "Untitled webinar",
    description: sanitizeString(raw.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    }),
    hostEmail: normalizeHostEmail(String(raw.hostEmail ?? "")),
    hostName: sanitizeString(raw.hostName, { max: 120, allowEmpty: true }),
    hostUserId: raw.hostUserId ? String(raw.hostUserId) : null,
    coHosts: sanitizeCoHosts(raw.coHosts),
    scheduledStartAt: Number(raw.scheduledStartAt) || Date.now(),
    scheduledEndAt:
      Number(raw.scheduledEndAt) ||
      (Number(raw.scheduledStartAt) || Date.now()) + DEFAULT_DURATION_MS,
    status,
    publicAccess: sanitizeBoolean(raw.publicAccess, true),
    maxAttendees: sanitizeMaxAttendees(raw.maxAttendees, DEFAULT_WEBINAR_MAX_ATTENDEES),
    requiresInviteCode: Boolean(raw.requiresInviteCode),
    waitingRoomEnabled: sanitizeBoolean(raw.waitingRoomEnabled, true),
    earlyEntryMinutes: sanitizeEarlyEntry(raw.earlyEntryMinutes, DEFAULT_EARLY_ENTRY_MINUTES),
    qaEnabled: sanitizeBoolean(raw.qaEnabled, true),
    recordingRequested: sanitizeBoolean(raw.recordingRequested, false),
    notes: sanitizeString(raw.notes, { max: MAX_NOTES_LENGTH, allowEmpty: true }),
    createdAt: Number(raw.createdAt) || Date.now(),
    createdBy: String(raw.createdBy ?? ""),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    liveStartedAt: raw.liveStartedAt ? Number(raw.liveStartedAt) : null,
    endedAt: raw.endedAt ? Number(raw.endedAt) : null,
    totalJoinCount: Number(raw.totalJoinCount) || 0,
    peakAttendeeCount: Number(raw.peakAttendeeCount) || 0,
    webinarLink: buildWebinarLink(linkSlug),
  };
};

export const loadPersistedSchedules = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
): number => {
  const snapshot = persistence.load();
  for (const webinar of snapshot) {
    indexScheduledWebinar(store, webinar);
  }
  return snapshot.length;
};

export const persistScheduledWebinars = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
): void => {
  persistence.save(Array.from(store.byId.values()));
};

export type CreateScheduledWebinarOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail?: string;
  defaultHostName?: string;
  defaultHostUserId?: string | null;
};

export const createScheduledWebinar = (
  store: ScheduledWebinarStore,
  request: CreateScheduledWebinarRequest,
  options: CreateScheduledWebinarOptions,
): { webinar: ScheduledWebinar; inviteCodeHash: string | null } => {
  const title = sanitizeString(request.title, { max: MAX_TITLE_LENGTH });
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new Error("Title is required.");
  }
  const description = sanitizeString(request.description, {
    max: MAX_DESCRIPTION_LENGTH,
    allowEmpty: true,
  });
  const notes = sanitizeString(request.notes, {
    max: MAX_NOTES_LENGTH,
    allowEmpty: true,
  });

  const scheduledStartAt = Number(request.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
    throw new Error("Invalid scheduled start time.");
  }
  const scheduledEndAt =
    Number.isFinite(Number(request.scheduledEndAt)) &&
    Number(request.scheduledEndAt) > scheduledStartAt
      ? Number(request.scheduledEndAt)
      : scheduledStartAt + DEFAULT_DURATION_MS;

  const hostEmail = normalizeHostEmail(
    request.hostEmail || options.defaultHostEmail || "",
  );
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new Error("Host email is required.");
  }
  const hostName = sanitizeString(
    request.hostName || options.defaultHostName,
    { max: 120, allowEmpty: true },
  );

  const coHosts = sanitizeCoHosts(request.coHosts).filter(
    (entry) => entry.email !== hostEmail,
  );

  const linkSlug = resolveLinkSlug(store, request.linkSlug);

  const publicAccess = sanitizeBoolean(request.publicAccess, true);
  const maxAttendees = sanitizeMaxAttendees(
    request.maxAttendees,
    DEFAULT_WEBINAR_MAX_ATTENDEES,
  );
  const inviteCodeRaw =
    typeof request.inviteCode === "string" ? request.inviteCode.trim() : "";
  const inviteCodeHash = inviteCodeRaw
    ? hashWebinarInviteCode(inviteCodeRaw)
    : null;
  const waitingRoomEnabled = sanitizeBoolean(request.waitingRoomEnabled, true);
  const earlyEntryMinutes = sanitizeEarlyEntry(
    request.earlyEntryMinutes,
    DEFAULT_EARLY_ENTRY_MINUTES,
  );
  const qaEnabled = sanitizeBoolean(request.qaEnabled, true);
  const recordingRequested = sanitizeBoolean(request.recordingRequested, false);

  const now = Date.now();
  const webinar: ScheduledWebinar = {
    id: randomUUID(),
    clientId: options.clientId,
    roomId: generateRoomId(),
    linkSlug,
    title,
    description,
    hostEmail,
    hostName,
    hostUserId: options.defaultHostUserId ?? null,
    coHosts,
    scheduledStartAt,
    scheduledEndAt,
    status: "scheduled",
    publicAccess,
    maxAttendees,
    requiresInviteCode: Boolean(inviteCodeHash),
    waitingRoomEnabled,
    earlyEntryMinutes,
    qaEnabled,
    recordingRequested,
    notes,
    createdAt: now,
    createdBy: options.createdBy,
    updatedAt: now,
    liveStartedAt: null,
    endedAt: null,
    totalJoinCount: 0,
    peakAttendeeCount: 0,
    webinarLink: buildWebinarLink(linkSlug),
  };

  indexScheduledWebinar(store, webinar);
  return { webinar, inviteCodeHash };
};

export const updateScheduledWebinar = (
  store: ScheduledWebinarStore,
  id: string,
  patch: UpdateScheduledWebinarRequest,
): { webinar: ScheduledWebinar; inviteCodeHashChange: { value: string | null } | null } => {
  const existing = store.byId.get(id);
  if (!existing) {
    throw new Error("Scheduled webinar not found.");
  }
  if (existing.status === "ended" || existing.status === "cancelled") {
    throw new Error("This webinar has already concluded.");
  }

  let inviteCodeHashChange: { value: string | null } | null = null;
  let titleChanged = false;
  let linkSlugChanged = false;

  if (patch.title !== undefined) {
    const next = sanitizeString(patch.title, { max: MAX_TITLE_LENGTH });
    if (next) {
      existing.title = next;
      titleChanged = true;
    }
  }
  if (patch.description !== undefined) {
    existing.description = sanitizeString(patch.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    });
  }
  if (patch.notes !== undefined) {
    existing.notes = sanitizeString(patch.notes, {
      max: MAX_NOTES_LENGTH,
      allowEmpty: true,
    });
  }
  if (typeof patch.scheduledStartAt === "number") {
    if (Number.isFinite(patch.scheduledStartAt) && patch.scheduledStartAt > 0) {
      existing.scheduledStartAt = patch.scheduledStartAt;
    }
  }
  if (typeof patch.scheduledEndAt === "number") {
    if (
      Number.isFinite(patch.scheduledEndAt) &&
      patch.scheduledEndAt > existing.scheduledStartAt
    ) {
      existing.scheduledEndAt = patch.scheduledEndAt;
    }
  }
  if (patch.hostEmail !== undefined) {
    const next = normalizeHostEmail(patch.hostEmail);
    if (next && next.includes("@")) {
      existing.hostEmail = next;
    }
  }
  if (patch.hostName !== undefined) {
    existing.hostName = sanitizeString(patch.hostName, {
      max: 120,
      allowEmpty: true,
    });
  }
  if (patch.coHosts !== undefined) {
    existing.coHosts = sanitizeCoHosts(patch.coHosts).filter(
      (entry) => entry.email !== existing.hostEmail,
    );
  }
  if (patch.linkSlug !== undefined) {
    const nextSlug = resolveLinkSlug(store, patch.linkSlug, existing.id);
    if (nextSlug !== existing.linkSlug) {
      store.bySlug.delete(existing.linkSlug);
      existing.linkSlug = nextSlug;
      existing.webinarLink = buildWebinarLink(nextSlug);
      store.bySlug.set(nextSlug, existing.id);
      linkSlugChanged = true;
    }
  }
  if (patch.publicAccess !== undefined) {
    existing.publicAccess = Boolean(patch.publicAccess);
  }
  if (patch.maxAttendees !== undefined) {
    existing.maxAttendees = sanitizeMaxAttendees(
      patch.maxAttendees,
      existing.maxAttendees,
    );
  }
  if (patch.inviteCode !== undefined) {
    if (patch.inviteCode === null || patch.inviteCode === "") {
      existing.requiresInviteCode = false;
      inviteCodeHashChange = { value: null };
    } else if (typeof patch.inviteCode === "string") {
      const trimmed = patch.inviteCode.trim();
      if (trimmed) {
        existing.requiresInviteCode = true;
        inviteCodeHashChange = { value: hashWebinarInviteCode(trimmed) };
      }
    }
  }
  if (patch.waitingRoomEnabled !== undefined) {
    existing.waitingRoomEnabled = Boolean(patch.waitingRoomEnabled);
  }
  if (patch.earlyEntryMinutes !== undefined) {
    existing.earlyEntryMinutes = sanitizeEarlyEntry(
      patch.earlyEntryMinutes,
      existing.earlyEntryMinutes,
    );
  }
  if (patch.qaEnabled !== undefined) {
    existing.qaEnabled = Boolean(patch.qaEnabled);
  }
  if (patch.recordingRequested !== undefined) {
    existing.recordingRequested = Boolean(patch.recordingRequested);
  }
  if (patch.status !== undefined) {
    const valid: ScheduledWebinarStatus[] = [
      "scheduled",
      "live",
      "ended",
      "cancelled",
    ];
    if (valid.includes(patch.status)) {
      existing.status = patch.status;
      if (patch.status === "live" && !existing.liveStartedAt) {
        existing.liveStartedAt = Date.now();
      }
      if (
        (patch.status === "ended" || patch.status === "cancelled") &&
        !existing.endedAt
      ) {
        existing.endedAt = Date.now();
      }
    }
  }

  existing.updatedAt = Date.now();
  void titleChanged;
  void linkSlugChanged;

  return { webinar: existing, inviteCodeHashChange };
};

export const deleteScheduledWebinar = (
  store: ScheduledWebinarStore,
  id: string,
): ScheduledWebinar | null => {
  const existing = store.byId.get(id);
  if (!existing) return null;
  removeFromIndexes(store, existing);
  return existing;
};

export const recordWebinarJoin = (
  store: ScheduledWebinarStore,
  id: string,
  currentAttendeeCount: number,
): void => {
  const webinar = store.byId.get(id);
  if (!webinar) return;
  webinar.totalJoinCount += 1;
  if (currentAttendeeCount > webinar.peakAttendeeCount) {
    webinar.peakAttendeeCount = currentAttendeeCount;
  }
  webinar.updatedAt = Date.now();
};

export const isWithinEarlyEntryWindow = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  const earlyMs = webinar.earlyEntryMinutes * 60 * 1000;
  return now >= webinar.scheduledStartAt - earlyMs;
};

export const hasWebinarEnded = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  if (webinar.status === "ended" || webinar.status === "cancelled") return true;
  return now > webinar.scheduledEndAt + 30 * 60 * 1000;
};

export const isUserScheduledHost = (
  webinar: ScheduledWebinar,
  email: string | null | undefined,
): boolean => {
  if (!email) return false;
  const normalized = normalizeHostEmail(email);
  if (!normalized) return false;
  if (webinar.hostEmail === normalized) return true;
  return webinar.coHosts.some((entry) => entry.email === normalized);
};
