import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import {
  getScheduledWebinarById,
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

  webinarConfig.enabled = true;
  webinarConfig.publicAccess = webinar.publicAccess;
  webinarConfig.maxAttendees = webinar.maxAttendees;
  webinarConfig.locked = false;
  webinarConfig.scheduledWebinarId = webinar.id;
  webinarConfig.waitingRoomEnabled = webinar.waitingRoomEnabled;
  webinarConfig.qaEnabled = webinar.qaEnabled;
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

export const advanceScheduledWebinars = (
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
        cfg.locked = true;
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

export const getScheduledWebinarFromConfig = (
  state: SfuState,
  channelId: string,
): ScheduledWebinar | null => {
  const cfg = state.webinarConfigs.get(channelId);
  if (!cfg?.scheduledWebinarId) return null;
  return getScheduledWebinarById(state.scheduledWebinars, cfg.scheduledWebinarId);
};
