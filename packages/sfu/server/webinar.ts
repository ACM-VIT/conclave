import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config/config.js";
import type { Room } from "../config/classes/Room.js";
import type {
  WebinarConfigSnapshot,
  WebinarFeedMode,
  WebinarUpdateRequest,
} from "../types.js";

export const DEFAULT_WEBINAR_MAX_ATTENDEES = 500;
export const MIN_WEBINAR_MAX_ATTENDEES = 1;
export const MAX_WEBINAR_MAX_ATTENDEES = 5000;

const RANDOM_WEBINAR_LINK_LENGTH = 5;
const MIN_WEBINAR_LINK_LENGTH = 3;
const MAX_WEBINAR_LINK_LENGTH = 32;
const WEBINAR_LINK_PATTERN = /^[a-z0-9-]+$/;
const RANDOM_WEBINAR_LINK_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

export type WebinarRoomConfig = {
  enabled: boolean;
  publicAccess: boolean;
  maxAttendees: number;
  locked: boolean;
  inviteCodeHash: string | null;
  linkVersion: number;
  linkSlug: string | null;
  feedMode: WebinarFeedMode;
};

export type WebinarLinkTarget = {
  roomChannelId: string;
  roomId: string;
  clientId: string;
};

export const createDefaultWebinarRoomConfig = (): WebinarRoomConfig => ({
  enabled: false,
  publicAccess: false,
  maxAttendees: DEFAULT_WEBINAR_MAX_ATTENDEES,
  locked: false,
  inviteCodeHash: null,
  linkVersion: 1,
  linkSlug: null,
  feedMode: "active-speaker",
});

export const getOrCreateWebinarRoomConfig = (
  webinarConfigs: Map<string, WebinarRoomConfig>,
  roomChannelId: string,
): WebinarRoomConfig => {
  const existing = webinarConfigs.get(roomChannelId);
  if (existing) {
    return existing;
  }

  const created = createDefaultWebinarRoomConfig();
  webinarConfigs.set(roomChannelId, created);
  return created;
};

export const normalizeWebinarMaxAttendees = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new Error("Invalid webinar attendee cap");
  }

  const normalized = Math.floor(value);
  if (normalized < MIN_WEBINAR_MAX_ATTENDEES) {
    throw new Error(
      `Webinar attendee cap must be at least ${MIN_WEBINAR_MAX_ATTENDEES}`,
    );
  }
  if (normalized > MAX_WEBINAR_MAX_ATTENDEES) {
    throw new Error(
      `Webinar attendee cap must be at most ${MAX_WEBINAR_MAX_ATTENDEES}`,
    );
  }

  return normalized;
};

const hashInviteCode = (inviteCode: string): string => {
  return createHmac("sha256", config.sfuSecret).update(inviteCode).digest("hex");
};

export const verifyInviteCode = (
  inviteCode: string,
  expectedHash: string,
): boolean => {
  const candidateHash = hashInviteCode(inviteCode);
  const expected = Buffer.from(expectedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");

  if (expected.length !== candidate.length) {
    return false;
  }

  return timingSafeEqual(expected, candidate);
};

export const normalizeWebinarLinkSlug = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Webinar link code cannot be empty.");
  }
  if (normalized.length < MIN_WEBINAR_LINK_LENGTH) {
    throw new Error(
      `Webinar link code must be at least ${MIN_WEBINAR_LINK_LENGTH} characters.`,
    );
  }
  if (normalized.length > MAX_WEBINAR_LINK_LENGTH) {
    throw new Error(
      `Webinar link code must be at most ${MAX_WEBINAR_LINK_LENGTH} characters.`,
    );
  }
  if (!WEBINAR_LINK_PATTERN.test(normalized)) {
    throw new Error("Use only lowercase letters, numbers, or hyphens in the link code.");
  }
  return normalized;
};

const randomWebinarLinkSlug = (length = RANDOM_WEBINAR_LINK_LENGTH): string => {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const pickIndex = Math.floor(
      Math.random() * RANDOM_WEBINAR_LINK_ALPHABET.length,
    );
    value += RANDOM_WEBINAR_LINK_ALPHABET[pickIndex];
  }
  return value;
};

const upsertWebinarLinkTarget = (
  webinarLinks: Map<string, WebinarLinkTarget>,
  slug: string,
  room: Pick<Room, "channelId" | "id" | "clientId">,
): void => {
  webinarLinks.set(slug, {
    roomChannelId: room.channelId,
    roomId: room.id,
    clientId: room.clientId,
  });
};

export const clearWebinarLinkSlug = (options: {
  webinarConfig: WebinarRoomConfig;
  webinarLinks: Map<string, WebinarLinkTarget>;
  roomChannelId: string;
}): boolean => {
  const { webinarConfig, webinarLinks, roomChannelId } = options;
  const currentSlug = webinarConfig.linkSlug;
  if (!currentSlug) {
    return false;
  }

  const currentTarget = webinarLinks.get(currentSlug);
  if (currentTarget?.roomChannelId === roomChannelId) {
    webinarLinks.delete(currentSlug);
  }

  webinarConfig.linkSlug = null;
  return true;
};

export const setCustomWebinarLinkSlug = (options: {
  webinarConfig: WebinarRoomConfig;
  webinarLinks: Map<string, WebinarLinkTarget>;
  room: Pick<Room, "channelId" | "id" | "clientId">;
  slug: string;
}): { slug: string; changed: boolean } => {
  const { webinarConfig, webinarLinks, room } = options;
  const normalizedSlug = normalizeWebinarLinkSlug(options.slug);
  const currentSlug = webinarConfig.linkSlug;

  const existingTarget = webinarLinks.get(normalizedSlug);
  if (existingTarget && existingTarget.roomChannelId !== room.channelId) {
    throw new Error("This webinar link code is already in use.");
  }

  if (currentSlug && currentSlug !== normalizedSlug) {
    const currentTarget = webinarLinks.get(currentSlug);
    if (currentTarget?.roomChannelId === room.channelId) {
      webinarLinks.delete(currentSlug);
    }
  }

  webinarConfig.linkSlug = normalizedSlug;
  upsertWebinarLinkTarget(webinarLinks, normalizedSlug, room);

  return {
    slug: normalizedSlug,
    changed: currentSlug !== normalizedSlug,
  };
};

export const rotateWebinarLinkSlug = (options: {
  webinarConfig: WebinarRoomConfig;
  webinarLinks: Map<string, WebinarLinkTarget>;
  room: Pick<Room, "channelId" | "id" | "clientId">;
}): string => {
  const { webinarConfig, webinarLinks, room } = options;
  const previousSlug = webinarConfig.linkSlug;

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = randomWebinarLinkSlug();
    const existingTarget = webinarLinks.get(candidate);
    const isConflict =
      existingTarget != null && existingTarget.roomChannelId !== room.channelId;

    if (isConflict || candidate === previousSlug) {
      continue;
    }

    setCustomWebinarLinkSlug({
      webinarConfig,
      webinarLinks,
      room,
      slug: candidate,
    });
    return candidate;
  }

  throw new Error("Unable to generate a unique webinar link code.");
};

export const ensureWebinarLinkSlug = (options: {
  webinarConfig: WebinarRoomConfig;
  webinarLinks: Map<string, WebinarLinkTarget>;
  room: Pick<Room, "channelId" | "id" | "clientId">;
}): string => {
  const { webinarConfig, webinarLinks, room } = options;
  const existingSlug = webinarConfig.linkSlug;

  if (!existingSlug) {
    return rotateWebinarLinkSlug(options);
  }

  const existingTarget = webinarLinks.get(existingSlug);
  if (existingTarget && existingTarget.roomChannelId !== room.channelId) {
    return rotateWebinarLinkSlug(options);
  }

  upsertWebinarLinkTarget(webinarLinks, existingSlug, room);
  return existingSlug;
};

export const resolveWebinarLinkTarget = (
  webinarLinks: Map<string, WebinarLinkTarget>,
  slug: string,
  clientId: string,
): WebinarLinkTarget | null => {
  let normalizedSlug = "";
  try {
    normalizedSlug = normalizeWebinarLinkSlug(slug);
  } catch {
    return null;
  }
  const target = webinarLinks.get(normalizedSlug);
  if (!target || target.clientId !== clientId) {
    return null;
  }
  return target;
};

export const updateWebinarRoomConfig = (
  webinarConfig: WebinarRoomConfig,
  update: WebinarUpdateRequest,
): { changed: boolean; linkVersionBumped: boolean } => {
  let changed = false;
  let linkVersionBumped = false;

  if (typeof update.enabled === "boolean" && webinarConfig.enabled !== update.enabled) {
    if (webinarConfig.enabled && !update.enabled) {
      webinarConfig.linkVersion += 1;
      linkVersionBumped = true;
    }
    webinarConfig.enabled = update.enabled;
    changed = true;
  }

  if (
    typeof update.publicAccess === "boolean" &&
    webinarConfig.publicAccess !== update.publicAccess
  ) {
    webinarConfig.publicAccess = update.publicAccess;
    changed = true;
  }

  if (typeof update.locked === "boolean" && webinarConfig.locked !== update.locked) {
    webinarConfig.locked = update.locked;
    changed = true;
  }

  if (typeof update.maxAttendees === "number") {
    const normalized = normalizeWebinarMaxAttendees(update.maxAttendees);
    if (webinarConfig.maxAttendees !== normalized) {
      webinarConfig.maxAttendees = normalized;
      changed = true;
    }
  }

  if (update.inviteCode !== undefined) {
    const normalizedInviteCode =
      typeof update.inviteCode === "string" ? update.inviteCode.trim() : "";
    const nextHash = normalizedInviteCode
      ? hashInviteCode(normalizedInviteCode)
      : null;
    if (webinarConfig.inviteCodeHash !== nextHash) {
      webinarConfig.inviteCodeHash = nextHash;
      changed = true;
    }
  }

  return { changed, linkVersionBumped };
};

export const toWebinarConfigSnapshot = (
  webinarConfig: WebinarRoomConfig,
  attendeeCount: number,
): WebinarConfigSnapshot => ({
  enabled: webinarConfig.enabled,
  publicAccess: webinarConfig.publicAccess,
  locked: webinarConfig.locked,
  maxAttendees: webinarConfig.maxAttendees,
  attendeeCount,
  requiresInviteCode: Boolean(webinarConfig.inviteCodeHash),
  linkSlug: webinarConfig.linkSlug,
  feedMode: webinarConfig.feedMode,
});

export const getWebinarBaseUrl = (): string => {
  const configured = process.env.WEBINAR_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  return "https://conclave.acmvit.in";
};
