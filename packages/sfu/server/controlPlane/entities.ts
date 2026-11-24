import { normalizeStoredMeeting } from "../scheduledMeetings.js";
import { normalizeStoredWebinar } from "../scheduledWebinars.js";
import {
  encodeStoredCalendar,
  normalizeStoredCalendar,
  normalizeStoredEventType,
  normalizeStoredHours,
  normalizeStoredProfile,
} from "../scheduling.js";
import { asRecord } from "../../utilities/untrusted.js";
import {
  DATA_KINDS,
  LEGACY_DOMAINS,
  LEGACY_IMPORT_ID,
  isActiveMeeting,
  isOpenWebinar,
  tags,
  uniqueKeys,
  type DataKind,
  type EntityMap,
  type Kind,
  type LegacyCopy,
  type LegacyDomain,
  type Deleted,
  type LegacyImportState,
  type Removal,
  type UniqueIndex,
} from "./model.js";

export type EntitySpec<K extends Kind> = {
  id: (value: EntityMap[K]) => string;
  identity?: (value: EntityMap[K]) => string;
  unique: (value: EntityMap[K]) => Array<[UniqueIndex, string]>;
  tags: (value: EntityMap[K]) => string[];
  encode: (value: EntityMap[K]) => unknown;
  decode: (raw: unknown) => EntityMap[K] | null;
};

type Registry = { [K in Kind]: EntitySpec<K> };

const same = <T>(value: T): T => value;

const decodeLegacyCopy = (raw: unknown): LegacyCopy | null => {
  const record = asRecord(raw);
  const { key, kind, id, hash, stamp } = record;
  if (typeof key !== "string" || typeof id !== "string" || typeof hash !== "string") return null;
  if (!DATA_KINDS.includes(kind as DataKind) || typeof stamp !== "number") return null;
  const source = typeof record.source === "string" ? record.source : "";
  return { key, source, kind: kind as DataKind, id, hash, stamp };
};

const decodeDeleted = (raw: unknown): Deleted | null => {
  const { identity, hash } = asRecord(raw);
  return typeof identity === "string" && typeof hash === "string" ? { identity, hash } : null;
};

const decodeRemoval = (raw: unknown): Removal | null => {
  const record = asRecord(raw);
  const { key, kind, id } = record;
  if (typeof key !== "string" || typeof id !== "string" || !DATA_KINDS.includes(kind as DataKind)) return null;
  const deleted = (Array.isArray(record.deleted) ? record.deleted : [])
    .map(decodeDeleted)
    .filter((entry): entry is Deleted => entry !== null);
  return { key, kind: kind as DataKind, id, deleted };
};

const decodeLegacyImport = (raw: unknown): LegacyImportState | null => {
  const record = asRecord(raw);
  if (record.id !== LEGACY_IMPORT_ID || typeof record.ticket !== "number") return null;
  const sources: Partial<Record<LegacyDomain, string>> = {};
  for (const [domain, source] of Object.entries(asRecord(record.sources))) {
    if (LEGACY_DOMAINS.includes(domain as LegacyDomain) && typeof source === "string") {
      sources[domain as LegacyDomain] = source;
    }
  }
  const completed = typeof record.completed === "number" ? record.completed : 0;
  const applied: Record<string, string> = {};
  for (const [key, order] of Object.entries(asRecord(record.applied))) {
    if (typeof order === "string") applied[key] = order;
  }
  return { id: LEGACY_IMPORT_ID, ticket: record.ticket, completed, sources, applied };
};

export const entities: Registry = {
  profile: {
    id: (profile) => profile.id,
    unique: (profile) => [
      ["profileUser", uniqueKeys.profileUser(profile.clientId, profile.userId)],
      ["profileUsername", uniqueKeys.profileUsername(profile.clientId, profile.username)],
    ],
    tags: () => [],
    encode: same,
    decode: normalizeStoredProfile,
  },
  hours: {
    id: (hours) => hours.profileId,
    unique: () => [],
    tags: () => [],
    encode: same,
    decode: (raw) => normalizeStoredHours(raw),
  },
  eventType: {
    id: (eventType) => eventType.id,
    unique: (eventType) => [
      ["eventSlug", uniqueKeys.eventSlug(eventType.profileId, eventType.slug)],
    ],
    tags: (eventType) => [tags.profileEventTypes(eventType.profileId)],
    encode: same,
    decode: normalizeStoredEventType,
  },
  calendar: {
    id: (calendar) => calendar.profileId,
    identity: (calendar) => calendar.id,
    unique: () => [],
    tags: () => [],
    encode: encodeStoredCalendar,
    decode: normalizeStoredCalendar,
  },
  meeting: {
    id: (meeting) => meeting.id,
    unique: (meeting) =>
      isActiveMeeting(meeting)
        ? [["meetingCode", uniqueKeys.meetingCode(meeting.clientId, meeting.roomCode)]]
        : [],
    tags: (meeting) => [
      tags.meetingCode(meeting.clientId, meeting.roomCode),
      ...(isActiveMeeting(meeting) ? [tags.activeMeetings] : []),
    ],
    encode: same,
    decode: normalizeStoredMeeting,
  },
  webinar: {
    id: (webinar) => webinar.id,
    unique: (webinar) => [
      ["webinarSlug", uniqueKeys.webinarSlug(webinar.linkSlug)],
      ["webinarRoom", uniqueKeys.webinarRoom(webinar.clientId, webinar.roomId)],
      ...(webinar.coHostInviteTokenHash
        ? [["cohostToken", uniqueKeys.cohostToken(webinar.coHostInviteTokenHash)] as [
            UniqueIndex,
            string,
          ]]
        : []),
    ],
    tags: (webinar) => (isOpenWebinar(webinar) ? [tags.openWebinars] : []),
    encode: same,
    decode: normalizeStoredWebinar,
  },
  legacyCopy: {
    id: (copy) => copy.key,
    unique: () => [],
    tags: () => [],
    encode: same,
    decode: decodeLegacyCopy,
  },
  legacyImport: {
    id: (state) => state.id,
    unique: () => [],
    tags: () => [],
    encode: same,
    decode: decodeLegacyImport,
  },
  removal: {
    id: (removal) => removal.key,
    unique: () => [],
    tags: () => [],
    encode: same,
    decode: decodeRemoval,
  },
};

export const identityOf = <K extends Kind>(kind: K, value: EntityMap[K]): string => {
  const spec = specOf(kind);
  return (spec.identity ?? spec.id)(value);
};

export const specOf = <K extends Kind>(kind: K): EntitySpec<K> => entities[kind];
