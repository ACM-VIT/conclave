import { createHash, randomBytes } from "node:crypto";
import type {
  CreateScheduledWebinarRequest,
  ScheduledWebinar,
  ScheduledWebinarCoHost,
  ScheduledWebinarStatus,
  UpdateScheduledWebinarRequest,
} from "../types.js";
import { asRecord } from "../utilities/untrusted.js";
import {
  DEFAULT_WEBINAR_MAX_ATTENDEES,
  MAX_WEBINAR_MAX_ATTENDEES,
  MIN_WEBINAR_MAX_ATTENDEES,
  getWebinarBaseUrl,
  hashWebinarInviteCode,
  normalizeWebinarLinkSlug,
  normalizeHostEmail,
} from "./webinar.js";
import { InvalidInput } from "./controlPlane/model.js";
import { canonicalizeClientId } from "./clientIds.js";

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
const CO_HOST_INVITE_TOKEN_BYTES = 32;

const sanitizeString = (
  value: unknown,
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
  value: unknown,
): ScheduledWebinarCoHost[] => {
  if (!Array.isArray(value)) return [];
  const entries: readonly unknown[] = value;
  const seen = new Set<string>();
  const result: ScheduledWebinarCoHost[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const email = normalizeHostEmail(String(record.email ?? ""));
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const name = sanitizeString(record.name, { max: 120, allowEmpty: true });
    result.push({ email, name: name || undefined });
    if (result.length >= MAX_CO_HOSTS) break;
  }
  return result;
};

export const randomWebinarSlug = (bytes: Buffer): string => {
  let out = "";
  for (let i = 0; i < RANDOM_SLUG_LENGTH; i += 1) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
};

export const RANDOM_WEBINAR_SLUG_BYTES = RANDOM_SLUG_LENGTH;

export const generateCoHostInviteToken = (): string =>
  randomBytes(CO_HOST_INVITE_TOKEN_BYTES).toString("base64url");

export const hashCoHostInviteToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const webinarRoomId = (bytes: Buffer): string =>
  `sched-${bytes.subarray(0, 4).toString("hex")}`;

export type WebinarSlugContext = {
  isSlugTaken: (slug: string) => boolean;
  randomSlug: () => string;
};

const resolveLinkSlug = (
  requested: string | undefined,
  context: WebinarSlugContext,
): string => {
  if (requested) {
    let normalized: string;
    try {
      normalized = normalizeWebinarLinkSlug(requested);
    } catch (error) {
      throw new InvalidInput((error as Error).message);
    }
    if (context.isSlugTaken(normalized)) {
      throw new InvalidInput("That webinar link code is already in use.");
    }
    return normalized;
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = context.randomSlug();
    if (!context.isSlugTaken(candidate)) return candidate;
  }
  throw new InvalidInput("Could not generate a unique webinar link.");
};

export const buildWebinarLink = (slug: string): string => {
  const base = getWebinarBaseUrl().replace(/\/$/, "");
  return `${base}/w/${encodeURIComponent(slug)}`;
};

export type ScheduledWebinarFilter = {
  clientId?: string;
  ownerEmail?: string;
  includeAll?: boolean;
  status?: ScheduledWebinarStatus[];
};

export const isWebinarHostOrCoHost = (
  webinar: ScheduledWebinar,
  email: string | null,
): boolean =>
  Boolean(
    email &&
      (webinar.hostEmail === email ||
        webinar.coHosts.some((entry) => entry.email === email)),
  );

export const filterScheduledWebinars = (
  webinars: readonly ScheduledWebinar[],
  filter: ScheduledWebinarFilter = {},
): ScheduledWebinar[] => {
  const ownerEmail = filter.ownerEmail ? normalizeHostEmail(filter.ownerEmail) : null;
  return webinars
    .filter((webinar) => {
      if (filter.clientId && webinar.clientId !== filter.clientId) return false;
      if (!filter.includeAll && ownerEmail && !isWebinarHostOrCoHost(webinar, ownerEmail)) {
        return false;
      }
      if (filter.status && !filter.status.includes(webinar.status)) return false;
      return true;
    })
    .sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};

export type CreateScheduledWebinarOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail?: string;
  defaultHostName?: string;
  defaultHostUserId?: string | null;
};

export const buildScheduledWebinar = (
  request: CreateScheduledWebinarRequest,
  options: CreateScheduledWebinarOptions,
  context: WebinarSlugContext & { id: string; roomId: string; now: number },
): { webinar: ScheduledWebinar; inviteCodeHash: string | null } => {
  const clientId = canonicalizeClientId(options.clientId);
  const title = sanitizeString(request.title, { max: MAX_TITLE_LENGTH });
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new InvalidInput("Title is required.");
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
    throw new InvalidInput("Invalid scheduled start time.");
  }
  const scheduledEndAt =
    Number.isFinite(Number(request.scheduledEndAt)) &&
    Number(request.scheduledEndAt) > scheduledStartAt
      ? Number(request.scheduledEndAt)
      : scheduledStartAt + DEFAULT_DURATION_MS;

  const requestedHostEmail = normalizeHostEmail(request.hostEmail || "");
  const requestHostEmailIsValid =
    requestedHostEmail.length > 0 && requestedHostEmail.includes("@");
  const fallbackHostEmail = normalizeHostEmail(options.defaultHostEmail || "");
  const hostEmail = requestHostEmailIsValid ? requestedHostEmail : fallbackHostEmail;
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new InvalidInput("Host email is required.");
  }
  const hostName = sanitizeString(request.hostName || options.defaultHostName, {
    max: 120,
    allowEmpty: true,
  });
  const coHosts = sanitizeCoHosts(request.coHosts).filter(
    (entry) => entry.email !== hostEmail,
  );
  const linkSlug = resolveLinkSlug(request.linkSlug, context);
  const inviteCodeRaw =
    typeof request.inviteCode === "string" ? request.inviteCode.trim() : "";
  const inviteCodeHash = inviteCodeRaw ? hashWebinarInviteCode(inviteCodeRaw) : null;

  const webinar: ScheduledWebinar = {
    id: context.id,
    clientId,
    roomId: context.roomId,
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
    publicAccess: sanitizeBoolean(request.publicAccess, true),
    maxAttendees: sanitizeMaxAttendees(request.maxAttendees, DEFAULT_WEBINAR_MAX_ATTENDEES),
    requiresInviteCode: Boolean(inviteCodeHash),
    waitingRoomEnabled: sanitizeBoolean(request.waitingRoomEnabled, true),
    earlyEntryMinutes: sanitizeEarlyEntry(request.earlyEntryMinutes, DEFAULT_EARLY_ENTRY_MINUTES),
    qaEnabled: sanitizeBoolean(request.qaEnabled, true),
    notes,
    createdAt: context.now,
    createdBy: options.createdBy,
    updatedAt: context.now,
    liveStartedAt: null,
    endedAt: null,
    totalJoinCount: 0,
    peakAttendeeCount: 0,
    webinarLink: buildWebinarLink(linkSlug),
    coHostInviteTokenHash: null,
    coHostInviteTokenCreatedAt: null,
  };
  return { webinar, inviteCodeHash };
};

export const isConcludedWebinar = (webinar: ScheduledWebinar): boolean =>
  webinar.status === "ended" || webinar.status === "cancelled";

export const applyScheduledWebinarUpdate = (
  existing: ScheduledWebinar,
  patch: UpdateScheduledWebinarRequest,
  context: WebinarSlugContext & { now: number },
): { webinar: ScheduledWebinar; inviteCodeHashChange: { value: string | null } | null } => {
  if (isConcludedWebinar(existing)) {
    throw new InvalidInput("This webinar has already concluded.");
  }
  const next: ScheduledWebinar = { ...existing, coHosts: [...existing.coHosts] };
  let inviteCodeHashChange: { value: string | null } | null = null;

  if (patch.title !== undefined) {
    const title = sanitizeString(patch.title, { max: MAX_TITLE_LENGTH });
    if (title) next.title = title;
  }
  if (patch.description !== undefined) {
    next.description = sanitizeString(patch.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    });
  }
  if (patch.notes !== undefined) {
    next.notes = sanitizeString(patch.notes, { max: MAX_NOTES_LENGTH, allowEmpty: true });
  }
  if (
    typeof patch.scheduledStartAt === "number" &&
    Number.isFinite(patch.scheduledStartAt) &&
    patch.scheduledStartAt > 0
  ) {
    next.scheduledStartAt = patch.scheduledStartAt;
  }
  if (
    typeof patch.scheduledEndAt === "number" &&
    Number.isFinite(patch.scheduledEndAt) &&
    patch.scheduledEndAt > next.scheduledStartAt
  ) {
    next.scheduledEndAt = patch.scheduledEndAt;
  }
  if (patch.hostEmail !== undefined) {
    const hostEmail = normalizeHostEmail(patch.hostEmail);
    if (hostEmail && hostEmail.includes("@")) next.hostEmail = hostEmail;
  }
  if (patch.hostName !== undefined) {
    next.hostName = sanitizeString(patch.hostName, { max: 120, allowEmpty: true });
  }
  if (patch.coHosts !== undefined) {
    next.coHosts = sanitizeCoHosts(patch.coHosts).filter(
      (entry) => entry.email !== next.hostEmail,
    );
  }
  if (patch.linkSlug !== undefined) {
    const nextSlug = resolveLinkSlug(patch.linkSlug, {
      ...context,
      isSlugTaken: (slug) => slug !== existing.linkSlug && context.isSlugTaken(slug),
    });
    if (nextSlug !== existing.linkSlug) {
      next.linkSlug = nextSlug;
      next.webinarLink = buildWebinarLink(nextSlug);
    }
  }
  if (patch.publicAccess !== undefined) next.publicAccess = Boolean(patch.publicAccess);
  if (patch.maxAttendees !== undefined) {
    next.maxAttendees = sanitizeMaxAttendees(patch.maxAttendees, existing.maxAttendees);
  }
  if (patch.inviteCode !== undefined) {
    if (patch.inviteCode === null || patch.inviteCode === "") {
      next.requiresInviteCode = false;
      inviteCodeHashChange = { value: null };
    } else if (typeof patch.inviteCode === "string") {
      const trimmed = patch.inviteCode.trim();
      if (trimmed) {
        next.requiresInviteCode = true;
        inviteCodeHashChange = { value: hashWebinarInviteCode(trimmed) };
      }
    }
  }
  if (patch.waitingRoomEnabled !== undefined) {
    next.waitingRoomEnabled = Boolean(patch.waitingRoomEnabled);
  }
  if (patch.earlyEntryMinutes !== undefined) {
    next.earlyEntryMinutes = sanitizeEarlyEntry(
      patch.earlyEntryMinutes,
      existing.earlyEntryMinutes,
    );
  }
  if (patch.qaEnabled !== undefined) next.qaEnabled = Boolean(patch.qaEnabled);
  if (patch.status !== undefined) {
    const valid: ScheduledWebinarStatus[] = ["scheduled", "live", "ended", "cancelled"];
    if (valid.includes(patch.status)) {
      next.status = patch.status;
      if (patch.status === "live" && !next.liveStartedAt) next.liveStartedAt = context.now;
      if ((patch.status === "ended" || patch.status === "cancelled") && !next.endedAt) {
        next.endedAt = context.now;
      }
    }
  }
  next.updatedAt = context.now;
  return { webinar: next, inviteCodeHashChange };
};

export const withWebinarJoin = (
  webinar: ScheduledWebinar,
  currentAttendeeCount: number,
  now: number,
): ScheduledWebinar => ({
  ...webinar,
  totalJoinCount: webinar.totalJoinCount + 1,
  peakAttendeeCount: Math.max(webinar.peakAttendeeCount, currentAttendeeCount),
  updatedAt: now,
});

export const withCoHostInvite = (
  webinar: ScheduledWebinar,
  tokenHash: string,
  now: number,
): ScheduledWebinar => {
  if (isConcludedWebinar(webinar)) {
    throw new InvalidInput("Cannot create a co-host link for a concluded webinar.");
  }
  return {
    ...webinar,
    coHostInviteTokenHash: tokenHash,
    coHostInviteTokenCreatedAt: now,
    updatedAt: now,
  };
};

export const acceptCoHostInvite = (
  webinar: ScheduledWebinar,
  user: { email: string; name?: string | null },
  now: number,
): ScheduledWebinar | null => {
  if (isConcludedWebinar(webinar)) {
    throw new InvalidInput("This co-host invite is no longer active.");
  }
  const email = normalizeHostEmail(user.email);
  if (webinar.hostEmail === email) return null;
  const existing = webinar.coHosts.find((entry) => entry.email === email);
  if (existing) {
    if (existing.name || !user.name) return null;
    const name = sanitizeString(user.name, { max: 120, allowEmpty: true }) || undefined;
    if (!name) return null;
    return {
      ...webinar,
      coHosts: webinar.coHosts.map((entry) => (entry.email === email ? { ...entry, name } : entry)),
      updatedAt: now,
    };
  }
  if (webinar.coHosts.length >= MAX_CO_HOSTS) {
    throw new InvalidInput(`A webinar can have at most ${MAX_CO_HOSTS} co-hosts.`);
  }
  const name = sanitizeString(user.name || undefined, { max: 120, allowEmpty: true });
  return {
    ...webinar,
    coHosts: [...webinar.coHosts, { email, name: name || undefined }],
    updatedAt: now,
  };
};

export const buildCoHostInviteLink = (token: string): string => {
  const base = getWebinarBaseUrl().replace(/\/$/, "");
  return `${base}/webinars/cohost/${encodeURIComponent(token)}`;
};

export const isWithinEarlyEntryWindow = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  const earlyMs = webinar.earlyEntryMinutes * 60 * 1000;
  return now >= webinar.scheduledStartAt - earlyMs;
};

export type ScheduledWebinarAttendeeEntry =
  | { kind: "unscheduled"; webinar: null }
  | { kind: "open" | "closed"; webinar: ScheduledWebinar };

export const resolveScheduledWebinarAttendeeEntry = (
  webinar: ScheduledWebinar | null,
  clientId: string,
  now = Date.now(),
): ScheduledWebinarAttendeeEntry => {
  if (!webinar) {
    return { kind: "unscheduled", webinar: null };
  }
  const isOpen =
    canonicalizeClientId(webinar.clientId) === canonicalizeClientId(clientId) &&
    !isConcludedWebinar(webinar) &&
    (webinar.status === "live" || isWithinEarlyEntryWindow(webinar, now));
  return { kind: isOpen ? "open" : "closed", webinar };
};

export const hasWebinarEnded = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  if (isConcludedWebinar(webinar)) return true;
  return now > webinar.scheduledEndAt + 30 * 60 * 1000;
};

export const advanceScheduledWebinar = (
  webinar: ScheduledWebinar,
  now: number,
): ScheduledWebinar | null => {
  if (webinar.status === "scheduled" && now >= webinar.scheduledStartAt) {
    return {
      ...webinar,
      status: "live",
      liveStartedAt: webinar.liveStartedAt || now,
      updatedAt: now,
    };
  }
  if (webinar.status === "live" && hasWebinarEnded(webinar, now)) {
    return { ...webinar, status: "ended", endedAt: now, updatedAt: now };
  }
  return null;
};

const finiteOrNull = (value: unknown): number | null =>
  value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;

export const normalizeStoredWebinar = (raw: unknown): ScheduledWebinar | null => {
  const record = asRecord(raw);
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.linkSlug !== "string" || !record.linkSlug) return null;
  if (typeof record.roomId !== "string" || !record.roomId) return null;
  if (typeof record.clientId !== "string" || !record.clientId) return null;
  const scheduledStartAt = finiteOrNull(record.scheduledStartAt);
  if (scheduledStartAt === null || scheduledStartAt <= 0) return null;
  const rawStatus = record.status;
  const status: ScheduledWebinarStatus =
    rawStatus === "live" || rawStatus === "ended" || rawStatus === "cancelled"
      ? rawStatus
      : "scheduled";
  const linkSlug = record.linkSlug;
  const endAt = finiteOrNull(record.scheduledEndAt);
  const updatedAtRaw = finiteOrNull(record.updatedAt);
  const createdAt = finiteOrNull(record.createdAt) ?? updatedAtRaw ?? 0;
  return {
    id: record.id,
    clientId: canonicalizeClientId(record.clientId),
    roomId: record.roomId,
    linkSlug,
    title: sanitizeString(record.title, { max: MAX_TITLE_LENGTH }) || "Untitled webinar",
    description: sanitizeString(record.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    }),
    hostEmail: normalizeHostEmail(typeof record.hostEmail === "string" ? record.hostEmail : ""),
    hostName: sanitizeString(record.hostName, { max: 120, allowEmpty: true }),
    hostUserId: typeof record.hostUserId === "string" && record.hostUserId ? record.hostUserId : null,
    coHosts: sanitizeCoHosts(record.coHosts),
    scheduledStartAt,
    scheduledEndAt: endAt && endAt > 0 ? endAt : scheduledStartAt + DEFAULT_DURATION_MS,
    status,
    publicAccess: sanitizeBoolean(record.publicAccess, true),
    maxAttendees: sanitizeMaxAttendees(record.maxAttendees, DEFAULT_WEBINAR_MAX_ATTENDEES),
    requiresInviteCode: Boolean(record.requiresInviteCode),
    waitingRoomEnabled: sanitizeBoolean(record.waitingRoomEnabled, true),
    earlyEntryMinutes: sanitizeEarlyEntry(record.earlyEntryMinutes, DEFAULT_EARLY_ENTRY_MINUTES),
    qaEnabled: sanitizeBoolean(record.qaEnabled, true),
    notes: sanitizeString(record.notes, { max: MAX_NOTES_LENGTH, allowEmpty: true }),
    createdAt,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "",
    updatedAt: updatedAtRaw ?? createdAt,
    liveStartedAt: finiteOrNull(record.liveStartedAt) || null,
    endedAt: finiteOrNull(record.endedAt) || null,
    totalJoinCount: finiteOrNull(record.totalJoinCount) ?? 0,
    peakAttendeeCount: finiteOrNull(record.peakAttendeeCount) ?? 0,
    webinarLink: buildWebinarLink(linkSlug),
    coHostInviteTokenHash:
      typeof record.coHostInviteTokenHash === "string" ? record.coHostInviteTokenHash : null,
    coHostInviteTokenCreatedAt: finiteOrNull(record.coHostInviteTokenCreatedAt) || null,
  };
};
