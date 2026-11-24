import { Logger } from "../utilities/loggers.js";
import { notifyAuthorityPolicy } from "./apps/authority/index.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import { isWithinEarlyEntryWindow } from "./scheduledWebinars.js";
import { advanceWebinars, openWebinars, webinarsByIds } from "./controlPlane/webinarCommands.js";
import type { SfuState } from "./state.js";
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
): void => {
  const next: ScheduledRoomControls = {
    status: webinar.status,
    publicAccess: webinar.publicAccess,
    maxAttendees: webinar.maxAttendees,
    waitingRoomEnabled: webinar.waitingRoomEnabled,
    qaEnabled: webinar.qaEnabled,
    inviteCodeHash: webinar.requiresInviteCode ? webinar.inviteCodeHash ?? undefined : null,
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
};

const appliedRevisions = new WeakMap<WebinarRoomConfig, number>();

const applyScheduledWebinarToConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
): WebinarRoomConfig => {
  const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
  const webinarConfig = getOrCreateWebinarRoomConfig(
    state.webinarConfigs,
    channelId,
  );

  applyScheduledRoomControls(webinarConfig, webinar);
  webinarConfig.scheduledWebinarId = webinar.id;

  const previousLinkSlug = webinarConfig.linkSlug;
  if (previousLinkSlug !== webinar.linkSlug) {
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
  return webinarConfig;
};

export const ensureWebinarRoomConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
): WebinarRoomConfig => applyScheduledWebinarToConfig(state, webinar);

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

export const advanceScheduledWebinars = async (
  state: SfuState,
  now = Date.now(),
): Promise<ScheduledWebinar[]> => {
  const advanced = await state.controlPlane.commit(advanceWebinars);
  const changed = advanced.ok ? advanced.value : [];
  for (const webinar of changed) {
    if (webinar.status === "live") applyScheduledWebinarToConfig(state, webinar);
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
      continue;
    }
    if (appliedRevisions.get(config) === record.rev) continue;
    applyScheduledWebinarToConfig(state, record.value);
    appliedRevisions.set(config, record.rev);
  }
  return changed;
};

export const startScheduledWebinarTimer = (
  state: SfuState,
  intervalMs = DEFAULT_TICK_MS,
): void => {
  if (state.scheduledWebinarTimer) return;
  state.scheduledWebinarTimer = setInterval(() => {
    advanceScheduledWebinars(state).catch((error) => {
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
