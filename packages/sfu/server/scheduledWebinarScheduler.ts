import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import {
  hasWebinarEnded,
  isWithinEarlyEntryWindow,
  persistScheduledWebinarChanges,
} from "./scheduledWebinars.js";
import type { SfuState } from "./state.js";
import {
  getOrCreateWebinarRoomConfig,
  normalizeHostEmail,
  setCustomWebinarLinkSlug,
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
    webinarConfig.inviteCodeHash = inviteCodeHash;
  }
  if (!webinarConfig.inviteCodeHash && !webinar.requiresInviteCode) {
    webinarConfig.inviteCodeHash = null;
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

  return webinarConfig;
};

export const ensureWebinarRoomConfig = (
  state: SfuState,
  webinar: ScheduledWebinar,
  inviteCodeHash: string | null = null,
): WebinarRoomConfig =>
  applyScheduledWebinarToConfig(state, webinar, inviteCodeHash);

const advanceScheduledWebinars = (
  state: SfuState,
  io: SocketIOServer | null,
  now = Date.now(),
): number => {
  let changed = 0;
  const changedWebinars: ScheduledWebinar[] = [];
  for (const webinar of state.scheduledWebinars.byId.values()) {
    if (webinar.status === "cancelled") continue;

    if (webinar.status === "scheduled" && isWithinEarlyEntryWindow(webinar, now)) {
      applyScheduledWebinarToConfig(state, webinar, null);
      if (now >= webinar.scheduledStartAt) {
        webinar.status = "live";
        if (!webinar.liveStartedAt) {
          webinar.liveStartedAt = now;
        }
        webinar.updatedAt = now;
        changedWebinars.push(webinar);
        changed += 1;
      }
    } else if (webinar.status === "live" && hasWebinarEnded(webinar, now)) {
      webinar.status = "ended";
      webinar.endedAt = now;
      webinar.updatedAt = now;
      changedWebinars.push(webinar);
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const cfg = state.webinarConfigs.get(channelId);
      if (cfg) {
        recordScheduledWebinarEnded(cfg, webinar);
      }
      void io;
      changed += 1;
    }
  }

  if (changed > 0 && state.scheduledWebinarPersistence) {
    persistScheduledWebinarChanges(
      state.scheduledWebinars,
      state.scheduledWebinarPersistence,
      changedWebinars,
    );
  }

  return changed;
};

export const startScheduledWebinarTimer = (
  state: SfuState,
  getIo: () => SocketIOServer | null,
  intervalMs = DEFAULT_TICK_MS,
): void => {
  if (state.scheduledWebinarTimer) return;
  state.scheduledWebinarTimer = setInterval(() => {
    try {
      advanceScheduledWebinars(state, getIo(), Date.now());
    } catch (error) {
      Logger.error("scheduled webinar tick failed", error);
    }
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
