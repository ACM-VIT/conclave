import { Logger } from "../utilities/loggers.js";
import { notifyAuthorityPolicy } from "./apps/authority/index.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import { isWithinEarlyEntryWindow } from "./scheduledWebinars.js";
import { advanceWebinars, openWebinars } from "./controlPlane/webinarCommands.js";
import type { SfuState } from "./state.js";
import {
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
  appliedScheduleControls.set(webinarConfig, next);
};

const recordScheduledWebinarEnded = (
  webinarConfig: WebinarRoomConfig,
  webinar: ScheduledWebinar,
): void => {
  webinarConfig.locked = true;
  const applied = appliedScheduleControls.get(webinarConfig);
  if (applied && webinarConfig.scheduledWebinarId === webinar.id) {
    appliedScheduleControls.set(webinarConfig, {
      ...applied,
      status: webinar.status,
    });
  }
};

const applyScheduledWebinarToConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
  inviteCodeHash: string | null,
): WebinarRoomConfig => {
  const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
  const webinarConfig = getOrCreateWebinarRoomConfig(
    state.webinarConfigs,
    channelId,
  );

  applyScheduledRoomControls(webinarConfig, webinar);
  webinarConfig.scheduledWebinarId = webinar.id;
  if (inviteCodeHash !== null) {
    setWebinarInviteCodeHash(webinarConfig, inviteCodeHash);
  }
  if (!webinarConfig.inviteCodeHash && !webinar.requiresInviteCode) {
    setWebinarInviteCodeHash(webinarConfig, null);
  }

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
  inviteCodeHash: string | null = null,
): WebinarRoomConfig =>
  applyScheduledWebinarToConfig(state, webinar, inviteCodeHash);

export const advanceScheduledWebinars = async (
  state: SfuState,
  now = Date.now(),
): Promise<ScheduledWebinar[]> => {
  const advanced = await state.controlPlane.commit(advanceWebinars);
  const changed = advanced.ok ? advanced.value : [];
  for (const webinar of changed) {
    if (webinar.status === "live") {
      applyScheduledWebinarToConfig(state, webinar, null);
      continue;
    }
    const cfg = state.webinarConfigs.get(getRoomChannelId(webinar.clientId, webinar.roomId));
    if (cfg) recordScheduledWebinarEnded(cfg, webinar);
  }
  for (const webinar of await state.controlPlane.read(openWebinars)) {
    if (webinar.status === "scheduled" && isWithinEarlyEntryWindow(webinar, now)) {
      applyScheduledWebinarToConfig(state, webinar, null);
    }
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
