import { normalizeStoredMeeting } from "../scheduledMeetings.js";
import { normalizeStoredWebinar } from "../scheduledWebinars.js";
import {
  encodeStoredCalendar,
  normalizeStoredCalendar,
  normalizeStoredEventType,
  normalizeStoredHours,
  normalizeStoredProfile,
} from "../scheduling.js";
import {
  isActiveMeeting,
  isOpenWebinar,
  tags,
  uniqueKeys,
  type EntityMap,
  type Kind,
  type UniqueIndex,
} from "./model.js";

export type EntitySpec<K extends Kind> = {
  id: (value: EntityMap[K]) => string;
  unique: (value: EntityMap[K]) => Array<[UniqueIndex, string]>;
  tags: (value: EntityMap[K]) => string[];
  encode: (value: EntityMap[K]) => unknown;
  decode: (raw: unknown) => EntityMap[K] | null;
};

type Registry = { [K in Kind]: EntitySpec<K> };

const same = <T>(value: T): T => value;

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
};

export const specOf = <K extends Kind>(kind: K): EntitySpec<K> => entities[kind];
