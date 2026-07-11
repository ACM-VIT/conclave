import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../../utilities/loggers.js";
import { renewRoomOwnerships } from "../rooms.js";
import { listScheduledMeetings } from "../scheduledMeetings.js";
import { listScheduledWebinars } from "../scheduledWebinars.js";
import { canonicalizeClientId } from "../clientIds.js";
import type { SfuState } from "../state.js";
import {
  getAdminAuditEntries,
  subscribeAdminAudit,
} from "./adminAudit.js";
import { toClusterSnapshot, toRoomSnapshot } from "./controlPlane.js";

/**
 * Live data plane for the operator dashboard. The browser connects straight to
 * this namespace (no polling proxy in the middle) with a short-lived HMAC
 * token minted by the web app's server, which holds the shared SFU secret.
 * The gateway pushes cluster and room snapshots whenever they change, plus an
 * activity feed, occupancy history, and the operator audit trail. Writes keep
 * flowing through the authenticated HTTP admin routes and their effects
 * stream back here within a tick.
 */

const ADMIN_NAMESPACE = "/admin";
const TICK_MS = 1000;
const WATCH_PREFIX = "admin:watch:";
const HISTORY_SAMPLE_MS = 10_000;
const HISTORY_MAX_POINTS = 360;
const EVENTS_MAX = 200;
const EVENTS_PER_TICK_MAX = 40;
const FIND_MATCH_LIMIT = 20;
const OWNERSHIP_RECONCILE_MS = 2_000;

type AdminRoomSummary = {
  channelId: string;
  roomId: string;
  clientId: string;
  participants: number;
  pending: number;
  admins: number;
  locked: boolean;
  screenShare: boolean;
  quality: "low" | "standard";
  activeAppId: string | null;
  activeGame: string | null;
};

type AdminScheduledItem = {
  kind: "meeting" | "webinar";
  id: string;
  title: string;
  clientId: string;
  roomId: string;
  /** Webinar link slug; meetings join by room code. */
  slug: string | null;
  status: string;
  startAt: number;
  endAt: number;
  host: string;
};

type AdminHistoryPoint = {
  at: number;
  rooms: number;
  participants: number;
  producers: number;
};

type AdminEventType =
  | "room-opened"
  | "room-closed"
  | "user-joined"
  | "user-left"
  | "screen-started"
  | "screen-stopped"
  | "room-locked"
  | "room-unlocked"
  | "waiting";

export type AdminEvent = {
  at: number;
  type: AdminEventType;
  roomId: string;
  channelId: string;
  message: string;
};

export type RoomOccupancy = {
  roomId: string;
  users: Map<string, string>;
  screen: boolean;
  locked: boolean;
  pendingCount: number;
};

type TokenCheck = { ok: true; subject: string } | { ok: false };

export const verifyAdminSocketToken = (
  token: unknown,
  secret: string,
): TokenCheck => {
  if (typeof token !== "string" || !secret) return { ok: false };
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return { ok: false };

  const expected = createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64url");
  const provided = Buffer.from(signaturePart);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return { ok: false };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as { sub?: unknown; exp?: unknown };
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return { ok: false };
    }
    return {
      ok: true,
      subject: typeof payload.sub === "string" ? payload.sub : "operator",
    };
  } catch {
    return { ok: false };
  }
};

/**
 * Synthesize the activity feed by diffing two occupancy views of the floor.
 * Pure so it can be unit tested; the gateway owns building the views.
 */
export const diffOccupancy = (
  previous: Map<string, RoomOccupancy>,
  next: Map<string, RoomOccupancy>,
  at: number,
): AdminEvent[] => {
  const events: AdminEvent[] = [];

  for (const [channelId, room] of next) {
    const before = previous.get(channelId);
    if (!before) {
      events.push({
        at,
        type: "room-opened",
        roomId: room.roomId,
        channelId,
        message: `Room ${room.roomId} opened`,
      });
      for (const name of room.users.values()) {
        events.push({
          at,
          type: "user-joined",
          roomId: room.roomId,
          channelId,
          message: `${name} joined ${room.roomId}`,
        });
      }
      continue;
    }

    for (const [userId, name] of room.users) {
      if (!before.users.has(userId)) {
        events.push({
          at,
          type: "user-joined",
          roomId: room.roomId,
          channelId,
          message: `${name} joined ${room.roomId}`,
        });
      }
    }
    for (const [userId, name] of before.users) {
      if (!room.users.has(userId)) {
        events.push({
          at,
          type: "user-left",
          roomId: room.roomId,
          channelId,
          message: `${name} left ${room.roomId}`,
        });
      }
    }

    if (room.screen !== before.screen) {
      events.push({
        at,
        type: room.screen ? "screen-started" : "screen-stopped",
        roomId: room.roomId,
        channelId,
        message: room.screen
          ? `Screen share started in ${room.roomId}`
          : `Screen share stopped in ${room.roomId}`,
      });
    }
    if (room.locked !== before.locked) {
      events.push({
        at,
        type: room.locked ? "room-locked" : "room-unlocked",
        roomId: room.roomId,
        channelId,
        message: room.locked
          ? `Room ${room.roomId} locked`
          : `Room ${room.roomId} unlocked`,
      });
    }
    if (room.pendingCount > before.pendingCount) {
      const delta = room.pendingCount - before.pendingCount;
      events.push({
        at,
        type: "waiting",
        roomId: room.roomId,
        channelId,
        message:
          delta === 1
            ? `Someone is waiting to join ${room.roomId}`
            : `${delta} people are waiting to join ${room.roomId}`,
      });
    }
  }

  for (const [channelId, before] of previous) {
    if (!next.has(channelId)) {
      events.push({
        at,
        type: "room-closed",
        roomId: before.roomId,
        channelId,
        message: `Room ${before.roomId} closed`,
      });
    }
  }

  return events;
};

const toRoomSummary = (
  room: SfuState["rooms"] extends Map<string, infer R> ? R : never,
): AdminRoomSummary => ({
  channelId: room.channelId,
  roomId: room.id,
  clientId: room.clientId,
  participants:
    room.getMeetingParticipantCount() + room.getWebinarAttendeeCount(),
  pending: room.pendingClients.size,
  admins: room.getAdmins().length,
  locked: room.isLocked,
  screenShare: Boolean(room.screenShareProducerId),
  quality: room.currentQuality,
  activeAppId: room.appsState.activeAppId,
  activeGame:
    room.gameSession && !room.gameSession.isFinished()
      ? room.gameSession.gameId
      : null,
});

export type AdminGatewayOptions = {
  io: SocketIOServer;
  state: SfuState;
  secret: string;
  instanceId: string;
  version: string;
};

export type AdminGateway = {
  dispose: () => void;
};

export const registerAdminGateway = (
  options: AdminGatewayOptions,
): AdminGateway => {
  const { io, state, secret, instanceId, version } = options;
  const nsp = io.of(ADMIN_NAMESPACE);

  nsp.use((socket, next) => {
    const check = verifyAdminSocketToken(socket.handshake.auth?.token, secret);
    if (!check.ok) {
      next(new Error("Unauthorized"));
      return;
    }
    (socket.data as { subject?: string }).subject = check.subject;
    next();
  });

  const buildOverview = () => ({
    instanceId,
    version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ...toClusterSnapshot(state),
  });

  const buildRoomSummaries = (): AdminRoomSummary[] =>
    Array.from(state.rooms.values()).map(toRoomSummary);

  // The scheduling calendar, flattened for the drawer: upcoming and live
  // first, capped so a busy booking-link tenant cannot flood the socket.
  const buildScheduled = (): AdminScheduledItem[] => {
    const items: AdminScheduledItem[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    const addItem = (item: AdminScheduledItem): void => {
      const normalizedItem = {
        ...item,
        clientId: canonicalizeClientId(item.clientId),
      };
      const key = [
        normalizedItem.kind,
        normalizedItem.clientId,
        normalizedItem.roomId,
      ].join(":");
      if (seen.has(key)) return;
      seen.add(key);
      items.push(normalizedItem);
    };

    for (const meeting of listScheduledMeetings(state.scheduledMeetings, {
      includeAll: true,
    })) {
      addItem({
        kind: "meeting",
        id: meeting.id,
        title: meeting.title,
        clientId: meeting.clientId,
        roomId: meeting.roomCode,
        slug: null,
        status: meeting.status,
        startAt: meeting.scheduledStartAt,
        endAt: meeting.scheduledEndAt,
        host: meeting.hostName || meeting.hostEmail,
      });
    }
    for (const webinar of listScheduledWebinars(state.scheduledWebinars, {
      includeAll: true,
    })) {
      addItem({
        kind: "webinar",
        id: webinar.id,
        title: webinar.title,
        clientId: webinar.clientId,
        roomId: webinar.roomId,
        slug: webinar.linkSlug || null,
        status: webinar.status,
        startAt: webinar.scheduledStartAt,
        endAt: webinar.scheduledEndAt,
        host: webinar.hostName || webinar.hostEmail,
      });
    }
    const relevance = (item: AdminScheduledItem): number => {
      if (item.status === "live" || (item.startAt <= now && item.endAt >= now)) {
        return 0;
      }
      if (item.endAt >= now) {
        return 1;
      }
      return 2;
    };
    items.sort((a, b) => {
      const aRelevance = relevance(a);
      const bRelevance = relevance(b);
      if (aRelevance !== bRelevance) return aRelevance - bRelevance;
      if (aRelevance === 2) {
        return b.endAt - a.endAt || b.startAt - a.startAt;
      }
      return a.startAt - b.startAt || a.endAt - b.endAt;
    });
    return items.slice(0, 100);
  };

  const buildOccupancy = (): Map<string, RoomOccupancy> => {
    const occupancy = new Map<string, RoomOccupancy>();
    for (const room of state.rooms.values()) {
      const users = new Map<string, string>();
      for (const client of room.clients.values()) {
        users.set(client.id, room.getDisplayNameForUser(client.id) || client.id);
      }
      occupancy.set(room.channelId, {
        roomId: room.id,
        users,
        screen: Boolean(room.screenShareProducerId),
        locked: room.isLocked,
        pendingCount: room.pendingClients.size,
      });
    }
    return occupancy;
  };

  // Change detection is snapshot-hash based: cheap at operator scale and it
  // needs zero instrumentation inside the SFU's hot paths.
  let lastOverviewJson = "";
  let lastRoomsJson = "";
  let lastScheduledJson = "";
  let lastScheduledCheckAt = 0;
  const lastRoomDetailJson = new Map<string, string>();
  const lastRoomChatJson = new Map<string, string>();
  let previousOccupancy: Map<string, RoomOccupancy> | null = null;
  const eventLog: AdminEvent[] = [];
  const history: AdminHistoryPoint[] = [];
  let lastHistorySampleAt = 0;
  let lastOwnershipReconcileAt = 0;
  let ownershipReconcilePromise: Promise<void> | null = null;
  let tickInFlight = false;

  const reconcileRoomOwnerships = async (
    now: number,
    opts?: { force?: boolean },
  ): Promise<void> => {
    if (state.rooms.size === 0) {
      lastOwnershipReconcileAt = now;
      return;
    }
    if (
      !opts?.force &&
      now - lastOwnershipReconcileAt < OWNERSHIP_RECONCILE_MS
    ) {
      return;
    }
    if (ownershipReconcilePromise) {
      await ownershipReconcilePromise;
      return;
    }

    lastOwnershipReconcileAt = now;
    ownershipReconcilePromise = renewRoomOwnerships(state)
      .catch((error) => {
        Logger.warn("[AdminGateway] room ownership reconciliation failed", error);
      })
      .finally(() => {
        ownershipReconcilePromise = null;
      });
    await ownershipReconcilePromise;
  };

  const watchedChannelIds = (): string[] => {
    const channels: string[] = [];
    for (const key of nsp.adapter.rooms.keys()) {
      if (typeof key === "string" && key.startsWith(WATCH_PREFIX)) {
        channels.push(key.slice(WATCH_PREFIX.length));
      }
    }
    return channels;
  };

  const emitRoomDetail = (channelId: string, opts?: { force?: boolean }) => {
    const room = state.rooms.get(channelId);
    const snapshot = room ? toRoomSnapshot(room) : null;
    const json = JSON.stringify(snapshot);
    if (!opts?.force && lastRoomDetailJson.get(channelId) === json) return;
    lastRoomDetailJson.set(channelId, json);
    nsp.local.to(`${WATCH_PREFIX}${channelId}`).emit("admin:room", {
      channelId,
      room: snapshot,
    });
  };

  // Broadcast chat only (the room's history buffer is already DM-free by
  // construction), so operators can read the room without joining it.
  const emitRoomChat = (channelId: string, opts?: { force?: boolean }) => {
    const room = state.rooms.get(channelId);
    const messages = room ? room.getChatHistorySnapshot() : [];
    const json = JSON.stringify(messages);
    if (!opts?.force && lastRoomChatJson.get(channelId) === json) return;
    lastRoomChatJson.set(channelId, json);
    nsp.local.to(`${WATCH_PREFIX}${channelId}`).emit("admin:chat", {
      channelId,
      messages,
    });
  };

  const sampleHistory = (now: number) => {
    if (now - lastHistorySampleAt < HISTORY_SAMPLE_MS) return;
    lastHistorySampleAt = now;
    const rooms = Array.from(state.rooms.values());
    const point: AdminHistoryPoint = {
      at: now,
      rooms: rooms.length,
      participants: rooms.reduce(
        (sum, room) =>
          sum + room.getMeetingParticipantCount() + room.getWebinarAttendeeCount(),
        0,
      ),
      producers: rooms.reduce((sum, room) => {
        let count = 0;
        for (const client of room.clients.values()) {
          count += client.producers.size;
        }
        return sum + count;
      }, 0),
    };
    history.push(point);
    if (history.length > HISTORY_MAX_POINTS) {
      history.splice(0, history.length - HISTORY_MAX_POINTS);
    }
    if (nsp.sockets.size > 0) {
      nsp.local.emit("admin:historyPoint", point);
    }
  };

  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    const now = Date.now();
    try {
      if (nsp.sockets.size > 0) {
        await reconcileRoomOwnerships(now);
      }
      // History and the activity log keep recording while nobody watches, so
      // a fresh session opens with context instead of a blank hour.
      sampleHistory(now);

      const occupancy = buildOccupancy();
      if (previousOccupancy) {
        const events = diffOccupancy(previousOccupancy, occupancy, now).slice(
          0,
          EVENTS_PER_TICK_MAX,
        );
        if (events.length > 0) {
          eventLog.push(...events);
          if (eventLog.length > EVENTS_MAX) {
            eventLog.splice(0, eventLog.length - EVENTS_MAX);
          }
          if (nsp.sockets.size > 0) {
            nsp.local.emit("admin:events", { events });
          }
        }
      }
      previousOccupancy = occupancy;

      if (nsp.sockets.size === 0) {
        // Nobody watching: drop diff caches so the next viewer gets full pushes.
        lastOverviewJson = "";
        lastRoomsJson = "";
        lastRoomDetailJson.clear();
        return;
      }

      const overview = buildOverview();
      // Uptime and timestamp always move; hash the parts that matter.
      const overviewHash = JSON.stringify({ ...overview, uptime: 0, timestamp: "" });
      if (overviewHash !== lastOverviewJson) {
        lastOverviewJson = overviewHash;
        nsp.local.emit("admin:overview", overview);
      }

      const rooms = buildRoomSummaries();
      const roomsJson = JSON.stringify(rooms);
      if (roomsJson !== lastRoomsJson) {
        lastRoomsJson = roomsJson;
        nsp.local.emit("admin:rooms", { rooms });
      }

      // The calendar changes rarely; check it on a slow cadence.
      if (now - lastScheduledCheckAt >= 30_000) {
        lastScheduledCheckAt = now;
        const scheduled = buildScheduled();
        const scheduledJson = JSON.stringify(scheduled);
        if (scheduledJson !== lastScheduledJson) {
          lastScheduledJson = scheduledJson;
          nsp.local.emit("admin:scheduled", { items: scheduled });
        }
      }

      const watched = new Set(watchedChannelIds());
      for (const channelId of watched) {
        emitRoomDetail(channelId);
        emitRoomChat(channelId);
      }
      for (const channelId of lastRoomDetailJson.keys()) {
        if (!watched.has(channelId)) {
          lastRoomDetailJson.delete(channelId);
        }
      }
      for (const channelId of lastRoomChatJson.keys()) {
        if (!watched.has(channelId)) {
          lastRoomChatJson.delete(channelId);
        }
      }
    } catch (error) {
      Logger.warn("[AdminGateway] tick failed", error);
    } finally {
      tickInFlight = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, TICK_MS);
  interval.unref?.();

  const unsubscribeAudit = subscribeAdminAudit((entry) => {
    if (nsp.sockets.size === 0) return;
    nsp.local.emit("admin:auditEntry", entry);
  });

  nsp.on("connection", (socket) => {
    Logger.info(
      `[AdminGateway] operator connected: ${String(
        (socket.data as { subject?: string }).subject,
      )}`,
    );
    socket.emit("admin:hello", {
      instanceId,
      version,
      serverNow: Date.now(),
    });
    void (async () => {
      try {
        await reconcileRoomOwnerships(Date.now(), { force: true });
        if (!socket.connected) return;
        socket.emit("admin:overview", buildOverview());
        socket.emit("admin:rooms", { rooms: buildRoomSummaries() });
        socket.emit("admin:history", { points: [...history] });
        socket.emit("admin:events", { events: [...eventLog], snapshot: true });
        socket.emit("admin:audit", { entries: getAdminAuditEntries() });
        socket.emit("admin:scheduled", { items: buildScheduled() });
      } catch (error) {
        Logger.warn("[AdminGateway] initial snapshot failed", error);
      }
    })();

    socket.on(
      "admin:watchRoom",
      async (
        payload: { channelId?: unknown } | undefined,
        ack?: (response: { ok: boolean }) => void,
      ) => {
        const channelId =
          payload && typeof payload.channelId === "string"
            ? payload.channelId
            : null;

        try {
          for (const key of socket.rooms) {
            if (typeof key === "string" && key.startsWith(WATCH_PREFIX)) {
              await Promise.resolve(socket.leave(key));
            }
          }

          if (!channelId) {
            ack?.({ ok: true });
            return;
          }

          await reconcileRoomOwnerships(Date.now(), { force: true });
          await socket.join(`${WATCH_PREFIX}${channelId}`);
          ack?.({ ok: true });
          emitRoomDetail(channelId, { force: true });
          emitRoomChat(channelId, { force: true });
        } catch (error) {
          Logger.warn("[AdminGateway] watch room subscription failed", error);
          ack?.({ ok: false });
        }
      },
    );

    socket.on(
      "admin:findUser",
      (
        payload: { query?: unknown } | undefined,
        ack?: (response: {
          matches: Array<{
            channelId: string;
            roomId: string;
            clientId: string;
            userId: string;
            displayName: string;
            userKey: string | null;
          }>;
        }) => void,
      ) => {
        const query =
          payload && typeof payload.query === "string"
            ? payload.query.trim().toLowerCase()
            : "";
        if (!query || !ack) {
          ack?.({ matches: [] });
          return;
        }

        const matches: Array<{
          channelId: string;
          roomId: string;
          clientId: string;
          userId: string;
          displayName: string;
          userKey: string | null;
          waiting?: boolean;
        }> = [];

        for (const room of state.rooms.values()) {
          for (const client of room.clients.values()) {
            const displayName =
              room.getDisplayNameForUser(client.id) || client.id;
            const userKey = room.userKeysById.get(client.id) ?? null;
            const haystack = `${displayName}\n${client.id}\n${userKey ?? ""}`.toLowerCase();
            if (!haystack.includes(query)) continue;
            matches.push({
              channelId: room.channelId,
              roomId: room.id,
              clientId: room.clientId,
              userId: client.id,
              displayName,
              userKey,
            });
            if (matches.length >= FIND_MATCH_LIMIT) break;
          }
          // The waiting room is where "where is X stuck?" usually resolves.
          for (const pending of room.pendingClients.values()) {
            if (matches.length >= FIND_MATCH_LIMIT) break;
            const displayName = pending.displayName || pending.userKey;
            const haystack =
              `${displayName}\n${pending.userId}\n${pending.userKey}`.toLowerCase();
            if (!haystack.includes(query)) continue;
            matches.push({
              channelId: room.channelId,
              roomId: room.id,
              clientId: room.clientId,
              userId: pending.userId,
              displayName,
              userKey: pending.userKey,
              waiting: true,
            });
          }
          if (matches.length >= FIND_MATCH_LIMIT) break;
        }

        ack({ matches });
      },
    );
  });

  return {
    dispose: () => {
      clearInterval(interval);
      unsubscribeAudit();
    },
  };
};
