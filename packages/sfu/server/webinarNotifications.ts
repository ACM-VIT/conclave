import type { Server as SocketIOServer } from "socket.io";
import type { Room } from "../config/classes/Room.js";
import type {
  WebinarAttendeeCountChangedNotification,
  WebinarConfigSnapshot,
  WebinarFeedChangedNotification,
  WebinarHandQueueChangedNotification,
  WebinarLinkResponse,
  WebinarQaChangedNotification,
  WebinarQaEntry,
} from "../types.js";
import { emitToHosts } from "./admin/hostOnlyEvents.js";
import { peekRoomAuthority } from "./apps/authority/index.js";
import type { SfuState } from "./state.js";
import {
  ensureWebinarLinkSlug,
  getOrCreateWebinarRoomConfig,
  getWebinarBaseUrl,
  toWebinarConfigSnapshot,
} from "./webinar.js";

/**
 * Attendee-count fanout is O(room size) per emit, and webinars churn joins in
 * bursts. Collapse rapid changes into at most one broadcast per window, with a
 * trailing emit so the final count always lands.
 */
const ATTENDEE_COUNT_EMIT_WINDOW_MS = 1_000;

type AttendeeCountEmitState = {
  lastEmitAt: number;
  timer: NodeJS.Timeout | null;
};

const attendeeCountEmitStates = new Map<string, AttendeeCountEmitState>();

export const getWebinarConfigSnapshot = (
  state: SfuState,
  room: Room,
): WebinarConfigSnapshot => {
  const webinarConfig = getOrCreateWebinarRoomConfig(
    state.webinarConfigs,
    room.channelId,
  );
  const attendeeCount = room.getWebinarAttendeeCount();
  return toWebinarConfigSnapshot(webinarConfig, attendeeCount);
};

export const emitWebinarConfigChanged = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  io.to(room.channelId).emit(
    "webinar:configChanged",
    getWebinarConfigSnapshot(state, room),
  );
  // Webinar mode and the Q&A switch decide what authority apps show to whom.
  peekRoomAuthority(room)?.policyChanged();
};

const emitWebinarAttendeeCountNow = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  const attendeeCount = room.getWebinarAttendeeCount();
  const webinarConfig = state.webinarConfigs.get(room.channelId);
  if (!webinarConfig && attendeeCount === 0) {
    return;
  }

  io.to(room.channelId).emit("webinar:attendeeCountChanged", {
    roomId: room.id,
    attendeeCount,
    maxAttendees:
      webinarConfig?.maxAttendees ??
      getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId)
        .maxAttendees,
  } satisfies WebinarAttendeeCountChangedNotification);
  // Attendee arrivals/departures are also the moments the raised-hand queue
  // can silently shrink (a viewer leaving lowers their hand with no other
  // signal), so refresh the hosts' queue on the same debounced cadence.
  emitWebinarHandQueueChanged(room);
};

export const emitWebinarAttendeeCountChanged = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  const channelId = room.channelId;
  let emitState = attendeeCountEmitStates.get(channelId);
  if (!emitState) {
    emitState = { lastEmitAt: 0, timer: null };
    attendeeCountEmitStates.set(channelId, emitState);
  }

  const now = Date.now();
  if (now - emitState.lastEmitAt >= ATTENDEE_COUNT_EMIT_WINDOW_MS) {
    emitState.lastEmitAt = now;
    emitWebinarAttendeeCountNow(io, state, room);
    // Long-lived process hygiene: once a room empties out, drop its throttle
    // record instead of accumulating one per room ever hosted.
    if (room.getWebinarAttendeeCount() === 0 && !emitState.timer) {
      attendeeCountEmitStates.delete(channelId);
    }
    return;
  }

  if (emitState.timer) {
    return;
  }

  const delay = ATTENDEE_COUNT_EMIT_WINDOW_MS - (now - emitState.lastEmitAt);
  emitState.timer = setTimeout(() => {
    emitState.timer = null;
    emitState.lastEmitAt = Date.now();
    // Re-resolve the room: it may have closed while the emit was pending.
    const liveRoom = state.rooms.get(channelId);
    if (!liveRoom) {
      attendeeCountEmitStates.delete(channelId);
      return;
    }
    emitWebinarAttendeeCountNow(io, state, liveRoom);
    if (liveRoom.getWebinarAttendeeCount() === 0) {
      attendeeCountEmitStates.delete(channelId);
    }
  }, delay);
  emitState.timer.unref?.();
};

const isPublishedQaStatus = (status: WebinarQaEntry["status"]): boolean =>
  status === "answering" || status === "answered";

/**
 * Fan out a Q&A change with the same visibility rules as snapshots: published
 * entries go to the whole room; pending/dismissed ones only to moderators and
 * the asker. When an entry leaves the published state, everyone else receives
 * a `removedId` so attendee lists stay pruned. Entries are projected without
 * per-viewer upvote state; clients track their own votes.
 */
export const emitWebinarQaEntryChanged = (
  io: SocketIOServer,
  room: Room,
  entry: WebinarQaEntry,
  options?: { wasPublished?: boolean },
): void => {
  const payload: WebinarQaChangedNotification = { roomId: room.id, entry };

  if (isPublishedQaStatus(entry.status)) {
    io.to(room.channelId).emit("webinar:qaChanged", payload);
    return;
  }

  const removalPayload: WebinarQaChangedNotification | null =
    options?.wasPublished
      ? { roomId: room.id, removedId: entry.id }
      : null;

  for (const client of room.clients.values()) {
    const isModerator = room.isAdminClient(client);
    if (isModerator || client.id === entry.userId) {
      client.socket.emit("webinar:qaChanged", payload);
    } else if (removalPayload) {
      client.socket.emit("webinar:qaChanged", removalPayload);
    }
  }
};

export const emitWebinarHandQueueChanged = (room: Room): void => {
  const notification: WebinarHandQueueChangedNotification = {
    roomId: room.id,
    queue: room.getWebinarHandQueue(),
  };
  emitToHosts(room, "webinar:handQueueChanged", notification);
};

export const emitWebinarFeedChanged = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  const webinarConfig = state.webinarConfigs.get(room.channelId);
  if (!webinarConfig?.enabled) {
    return;
  }

  const snapshot = room.refreshWebinarFeedSnapshot();
  if (!snapshot.changed) {
    return;
  }

  io.to(room.channelId).emit("webinar:feedChanged", {
    roomId: room.id,
    speakerUserId: snapshot.speakerUserId,
    producers: snapshot.producers,
  } satisfies WebinarFeedChangedNotification);
  enforceWebinarFeedForAttendees(room, snapshot.producers);
};

/**
 * Server-side program-feed enforcement: when the stage changes, close any
 * attendee consumer that no longer belongs to the feed. Honest clients tear
 * these down themselves; this stops a modified client from silently keeping
 * an off-stage camera or a producer id it was never offered.
 */
const enforceWebinarFeedForAttendees = (
  room: Room,
  feedProducers: { producerId: string }[],
): void => {
  const allowedProducerIds = new Set(
    feedProducers.map((producer) => producer.producerId),
  );
  for (const client of room.clients.values()) {
    if (!client.isWebinarAttendee) continue;
    for (const [producerId, consumer] of client.consumers) {
      if (allowedProducerIds.has(producerId)) continue;
      // close() fires the consumer's observer cleanup, which already removes
      // it from the client's consumer maps.
      try {
        consumer.close();
      } catch {}
    }
  }
};

export const getWebinarLinkResponse = (
  state: SfuState,
  room: Room,
  options: {
    linkVersion: number;
    publicAccess: boolean;
  },
): WebinarLinkResponse => {
  const webinarConfig = getOrCreateWebinarRoomConfig(
    state.webinarConfigs,
    room.channelId,
  );
  const slug = ensureWebinarLinkSlug({
    webinarConfig,
    webinarLinks: state.webinarLinks,
    room,
  });
  const base = getWebinarBaseUrl();
  const path = `${base}/w/${encodeURIComponent(slug)}`;

  return {
    slug,
    link: path,
    publicAccess: options.publicAccess,
    linkVersion: options.linkVersion,
  };
};
