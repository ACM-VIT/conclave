import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { notifyAuthorityPolicy } from "./apps/authority/index.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import { isWithinEarlyEntryWindow } from "./scheduledWebinars.js";
import { advanceWebinars, openWebinars, webinarsByIds } from "./controlPlane/webinarCommands.js";
import type { SfuState } from "./state.js";
import { emitWebinarConfigChanged } from "./webinarNotifications.js";
import {
  clearWebinarLinkSlug,
  getOrCreateWebinarRoomConfig,
  normalizeHostEmail,
  setCustomWebinarLinkSlug,
  setWebinarInviteCodeHash,
  type WebinarRoomConfig,
} from "./webinar.js";

const DEFAULT_TICK_MS = 10_000;

/** Room controls a schedule seeds and the host can then change live. */
type ScheduledRoomControls = {
  status: ScheduledWebinar["status"];
  publicAccess: boolean;
  maxAttendees: number;
  waitingRoomEnabled: boolean;
  qaEnabled: boolean;
  inviteCodeHash: string | null | undefined;
  linkSlug: string;
};

/**
 * The schedule values last copied into each room config. The schedule is
 * re-applied on every panelist join, on the scheduler tick and on schedule
 * edits; only values the schedule itself changed since then are copied
 * again, so a host's live lock, Q&A toggle or attendee cap is not reverted
 * by the next join.
 */
const appliedScheduleControls = new WeakMap<
  WebinarRoomConfig,
  ScheduledRoomControls
>();

const isTerminalWebinarStatus = (status: ScheduledWebinar["status"]): boolean =>
  status === "ended" || status === "cancelled";

const applyScheduledRoomControls = (
  webinarConfig: WebinarRoomConfig,
  webinar: ScheduledWebinar,
): ScheduledRoomControls | undefined => {
  const next: ScheduledRoomControls = {
    status: webinar.status,
    publicAccess: webinar.publicAccess,
    maxAttendees: webinar.maxAttendees,
    waitingRoomEnabled: webinar.waitingRoomEnabled,
    qaEnabled: webinar.qaEnabled,
    inviteCodeHash: webinar.requiresInviteCode ? webinar.inviteCodeHash ?? undefined : null,
    linkSlug: webinar.linkSlug,
  };
  const previous =
    webinarConfig.scheduledWebinarId === webinar.id
      ? appliedScheduleControls.get(webinarConfig)
      : undefined;

  const wasOpen = previous ? !isTerminalWebinarStatus(previous.status) : false;
  const isOpen = !isTerminalWebinarStatus(next.status);
  if (isOpen && !wasOpen) {
    // First application, or the schedule was reopened: open the room.
    webinarConfig.enabled = true;
    webinarConfig.locked = false;
  } else if (!isOpen) {
    // Ended or cancelled schedules lock the room, as the /end and /cancel
    // routes and the scheduler tick do.
    webinarConfig.locked = true;
    if (next.status === "cancelled") {
      webinarConfig.enabled = false;
    }
  }

  if (!previous || previous.publicAccess !== next.publicAccess) {
    webinarConfig.publicAccess = next.publicAccess;
  }
  if (!previous || previous.maxAttendees !== next.maxAttendees) {
    webinarConfig.maxAttendees = next.maxAttendees;
  }
  if (!previous || previous.waitingRoomEnabled !== next.waitingRoomEnabled) {
    webinarConfig.waitingRoomEnabled = next.waitingRoomEnabled;
  }
  if (!previous || previous.qaEnabled !== next.qaEnabled) {
    webinarConfig.qaEnabled = next.qaEnabled;
  }
  if (next.inviteCodeHash !== undefined && (!previous || previous.inviteCodeHash !== next.inviteCodeHash)) {
    setWebinarInviteCodeHash(webinarConfig, next.inviteCodeHash);
  }
  appliedScheduleControls.set(webinarConfig, next);
  return previous;
};

const appliedRevisions = new WeakMap<WebinarRoomConfig, number>();

const applyScheduledWebinarToConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
): { webinarConfig: WebinarRoomConfig; bound: boolean } => {
  const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
  const webinarConfig = getOrCreateWebinarRoomConfig(
    state.webinarConfigs,
    channelId,
  );

  const previous = applyScheduledRoomControls(webinarConfig, webinar);
  webinarConfig.scheduledWebinarId = webinar.id;

  const scheduleSlugChanged = !previous || previous.linkSlug !== webinar.linkSlug;
  let bound = true;
  if (scheduleSlugChanged && webinarConfig.linkSlug !== webinar.linkSlug) {
    try {
      setCustomWebinarLinkSlug({
        webinarConfig,
        webinarLinks: state.webinarLinks,
        room: {
          channelId,
          id: webinar.roomId,
          clientId: webinar.clientId,
        },
        slug: webinar.linkSlug,
      });
    } catch (error) {
      bound = false;
      appliedScheduleControls.set(webinarConfig, {
        ...(appliedScheduleControls.get(webinarConfig) as ScheduledRoomControls),
        linkSlug: previous?.linkSlug ?? "",
      });
      Logger.warn(
        `Failed to bind webinar link slug ${webinar.linkSlug}: ${(error as Error).message}`,
      );
    }
  }

  const nextForcedHosts = new Set<string>();
  if (webinar.hostEmail) {
    nextForcedHosts.add(normalizeHostEmail(webinar.hostEmail));
  }
  for (const cohost of webinar.coHosts) {
    nextForcedHosts.add(normalizeHostEmail(cohost.email));
  }
  webinarConfig.forcedHostEmails = nextForcedHosts;

  // A schedule can open, cancel or reopen the webinar and switch its Q&A.
  notifyAuthorityPolicy(state, channelId);
  return { webinarConfig, bound };
};

export const ensureWebinarRoomConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
): WebinarRoomConfig => applyScheduledWebinarToConfig(state, webinar).webinarConfig;

const releaseRemovedSchedule = (
  state: SfuState,
  channelId: string,
  webinarConfig: WebinarRoomConfig,
): void => {
  clearWebinarLinkSlug({
    webinarConfig,
    webinarLinks: state.webinarLinks,
    roomChannelId: channelId,
  });
  webinarConfig.enabled = false;
  webinarConfig.forcedHostEmails = new Set();
  webinarConfig.scheduledWebinarId = null;
  appliedRevisions.delete(webinarConfig);
  notifyAuthorityPolicy(state, channelId);
};

export type WebinarConfigNotify = (channelId: string) => void;

export const notifyRoomConfig =
  (state: SfuState, getIo: () => SocketIOServer | null): WebinarConfigNotify =>
  (channelId) => {
    const io = getIo();
    const room = state.rooms.get(channelId);
    if (io && room) emitWebinarConfigChanged(io, state, room);
  };

export const advanceScheduledWebinars = async (
  state: SfuState,
  now = Date.now(),
  notify: WebinarConfigNotify = () => {},
): Promise<ScheduledWebinar[]> => {
  const advanced = await state.controlPlane.commit(advanceWebinars);
  const changed = advanced.ok ? advanced.value : [];
  const touched = new Set<string>();
  for (const webinar of changed) {
    if (webinar.status === "live") applyScheduledWebinarToConfig(state, webinar);
    touched.add(getRoomChannelId(webinar.clientId, webinar.roomId));
  }
  for (const webinar of await state.controlPlane.read(openWebinars)) {
    if (webinar.status === "scheduled" && isWithinEarlyEntryWindow(webinar, now)) {
      applyScheduledWebinarToConfig(state, webinar);
    }
  }
  const hosted = [...state.webinarConfigs].filter(([, config]) => config.scheduledWebinarId);
  const stored = await state.controlPlane.read(
    webinarsByIds(hosted.map(([, config]) => config.scheduledWebinarId as string)),
  );
  for (const [channelId, config] of hosted) {
    const id = config.scheduledWebinarId as string;
    const record = stored.get(id) ?? null;
    if (!record) {
      releaseRemovedSchedule(state, channelId, config);
      touched.add(channelId);
      continue;
    }
    if (appliedRevisions.get(config) === record.rev) continue;
    if (applyScheduledWebinarToConfig(state, record.value).bound) {
      appliedRevisions.set(config, record.rev);
    }
    touched.add(channelId);
  }
  for (const channelId of touched) {
    if (state.webinarConfigs.has(channelId)) notify(channelId);
  }
  return changed;
};

export const startScheduledWebinarTimer = (
  state: SfuState,
  intervalMs = DEFAULT_TICK_MS,
  notify?: WebinarConfigNotify,
): void => {
  if (state.scheduledWebinarTimer) return;
  state.scheduledWebinarTimer = setInterval(() => {
    advanceScheduledWebinars(state, Date.now(), notify).catch((error) => {
      Logger.error("scheduled webinar tick failed", error);
    });
  }, intervalMs);
  if (state.scheduledWebinarTimer.unref) {
    state.scheduledWebinarTimer.unref();
  }
};

export const stopScheduledWebinarTimer = (state: SfuState): void => {
  if (!state.scheduledWebinarTimer) return;
  clearInterval(state.scheduledWebinarTimer);
  state.scheduledWebinarTimer = null;
};
