import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { notifyAuthorityPolicy } from "./apps/authority/index.js";
import { getRoomChannelId } from "./rooms.js";
import type { ScheduledWebinar } from "../types.js";
import { isWithinEarlyEntryWindow } from "./scheduledWebinars.js";
import { advanceWebinars, openWebinars, webinarsByIds, type WebinarSchedule } from "./controlPlane/webinarCommands.js";
import type { Query } from "./controlPlane/tx.js";
import type { SfuState } from "./state.js";
import { emitWebinarAttendeeCountChanged, emitWebinarConfigChanged } from "./webinarNotifications.js";
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
 * by the next join. A delayed result cannot replace a newer revision.
 */
const appliedSchedule = new WeakMap<WebinarRoomConfig, {
  rev: number;
  controls: ScheduledRoomControls | null;
}>();

const isTerminalWebinarStatus = (status: ScheduledWebinar["status"]): boolean =>
  status === "ended" || status === "cancelled";

const applyScheduledRoomControls = (
  webinarConfig: WebinarRoomConfig,
  webinar: ScheduledWebinar,
): { previous: ScheduledRoomControls | undefined; next: ScheduledRoomControls } => {
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
      ? appliedSchedule.get(webinarConfig)?.controls ?? undefined
      : undefined;

  const wasOpen = previous ? !isTerminalWebinarStatus(previous.status) : false;
  const isOpen = !isTerminalWebinarStatus(next.status);
  if (isOpen && !wasOpen) {
    // First application, or the schedule was reopened: open the room.
    webinarConfig.enabled = true;
    webinarConfig.locked = false;
  } else if (!isOpen && previous?.status !== next.status) {
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
  return { previous, next };
};

const applyScheduledWebinarToConfig = (
  state: SfuState,
  channelId: string,
  webinarConfig: WebinarRoomConfig,
  webinar: ScheduledWebinar,
  rev: number,
): void => {
  const { previous, next } = applyScheduledRoomControls(webinarConfig, webinar);
  webinarConfig.scheduledWebinarId = webinar.id;

  const scheduleSlugChanged = !previous || previous.linkSlug !== webinar.linkSlug;
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
      next.linkSlug = previous?.linkSlug ?? "";
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
  appliedSchedule.set(webinarConfig, { rev, controls: next });
};

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
};

export type WebinarConfigNotify = (channelId: string) => void;

const deferredRoomNotices = new WeakSet<WebinarRoomConfig>();

export const deferWebinarRoomNotice = (state: SfuState, channelId: string): void => {
  const config = state.webinarConfigs.get(channelId);
  if (config) deferredRoomNotices.add(config);
};

export const takeDeferredWebinarRoomNotice = (state: SfuState, channelId: string): boolean => {
  const config = state.webinarConfigs.get(channelId);
  return config !== undefined && deferredRoomNotices.delete(config);
};

export const notifyRoomConfig =
  (state: SfuState, getIo: () => SocketIOServer | null): WebinarConfigNotify =>
  (channelId) => {
    const io = getIo();
    const room = state.rooms.get(channelId);
    if (!io || !room) return;
    emitWebinarConfigChanged(io, state, room);
    emitWebinarAttendeeCountChanged(io, state, room);
  };

const settingsOf = (config: WebinarRoomConfig | undefined): string =>
  config ? JSON.stringify({ ...config, forcedHostEmails: [...config.forcedHostEmails].sort() }) : "";

const channelOf = (webinar: Pick<ScheduledWebinar, "clientId" | "roomId">): string =>
  getRoomChannelId(webinar.clientId, webinar.roomId);

const settleWebinarRoom = (
  state: SfuState,
  channelId: string,
  update: { id: string; rev: number; value: ScheduledWebinar | null },
  notify: WebinarConfigNotify,
): void => {
  const current = state.webinarConfigs.get(channelId);
  const { id, rev, value } = update;
  if (value ? channelOf(value) !== channelId : current?.scheduledWebinarId !== id) return;
  if (current && rev < (appliedSchedule.get(current)?.rev ?? -1)) return;
  const before = settingsOf(current);
  const config = current ?? getOrCreateWebinarRoomConfig(state.webinarConfigs, channelId);
  if (value) {
    applyScheduledWebinarToConfig(state, channelId, config, value, rev);
  } else {
    releaseRemovedSchedule(state, channelId, config);
    appliedSchedule.set(config, { rev, controls: null });
  }
  const changed = settingsOf(config) !== before;
  if (changed) notifyAuthorityPolicy(state, channelId);
  const deferred = takeDeferredWebinarRoomNotice(state, channelId);
  if (changed || deferred) notify(channelId);
};

const readForPublication = async <T, R>(
  state: SfuState,
  query: Query<T>,
  publish: (result: T) => R,
): Promise<R> => {
  while (true) {
    const removalEpoch = state.webinarRemovalEpoch;
    const result = await state.controlPlane.read(query);
    // A tombstone may have no room config to retain its revision across this read.
    if (removalEpoch === state.webinarRemovalEpoch) return publish(result);
  }
};

export const readWebinarScheduleForJoin = <T>(
  state: SfuState,
  query: Query<WebinarSchedule | null>,
  notify: WebinarConfigNotify,
  use: (schedule: WebinarSchedule | null) => { result: T; publish: boolean },
): Promise<T> =>
  readForPublication(state, query, (schedule) => {
    const { result, publish } = use(schedule);
    if (schedule && publish) {
      settleWebinarRoom(state, channelOf(schedule.value), { id: schedule.value.id, ...schedule }, notify);
    }
    return result;
  });

const reconcileWebinarRooms = (
  state: SfuState,
  roomsByWebinar: ReadonlyMap<string, string>,
  notify: WebinarConfigNotify,
): Promise<void> =>
  readForPublication(state, webinarsByIds([...roomsByWebinar.keys()]), (records) => {
    for (const [id, channelId] of roomsByWebinar) {
      const record = records.get(id);
      if (!record) continue;
      if (record.value === null) state.webinarRemovalEpoch += 1;
      settleWebinarRoom(state, channelId, { id, ...record }, notify);
    }
  });

export const refreshWebinarRoomConfig = (
  state: SfuState,
  webinar: Pick<ScheduledWebinar, "id" | "clientId" | "roomId">,
  notify: WebinarConfigNotify,
): Promise<void> => reconcileWebinarRooms(state, new Map([[webinar.id, channelOf(webinar)]]), notify);

export const advanceScheduledWebinars = async (
  state: SfuState,
  now: number,
  notify: WebinarConfigNotify,
): Promise<ScheduledWebinar[]> => {
  const advanced = await state.controlPlane.commit(advanceWebinars);
  const changed = advanced.ok ? advanced.value : [];
  const roomsByWebinar = new Map<string, string>();
  for (const webinar of changed) {
    const channelId = channelOf(webinar);
    if (webinar.status === "live" || state.webinarConfigs.has(channelId)) {
      roomsByWebinar.set(webinar.id, channelId);
    }
  }
  for (const { value: webinar } of await state.controlPlane.read(openWebinars)) {
    if (webinar.status === "scheduled" && isWithinEarlyEntryWindow(webinar, now)) {
      roomsByWebinar.set(webinar.id, channelOf(webinar));
    }
  }
  for (const [channelId, { scheduledWebinarId: id }] of state.webinarConfigs) {
    if (id && !roomsByWebinar.has(id)) roomsByWebinar.set(id, channelId);
  }
  if (roomsByWebinar.size > 0) {
    await reconcileWebinarRooms(state, roomsByWebinar, notify);
  }
  return changed;
};

export const startScheduledWebinarTimer = (
  state: SfuState,
  notify: WebinarConfigNotify,
  intervalMs = DEFAULT_TICK_MS,
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
