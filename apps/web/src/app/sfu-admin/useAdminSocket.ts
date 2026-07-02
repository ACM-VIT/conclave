"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { readResponseError } from "../lib/utils";
import type {
  AdminChatMessage,
  AdminHistoryPoint,
  AdminRoomSummary,
  AdminScheduledItem,
  ClusterOverview,
  ConnectionState,
  InstanceStatus,
  RoomSelection,
  RoomSnapshot,
  TaggedAdminEvent,
  TaggedAuditEntry,
  TaggedFindMatch,
  TaggedRoomSummary,
  TaggedScheduledItem,
} from "./types";

const EVENTS_CAP = 300;
const AUDIT_CAP = 200;
const FIND_TIMEOUT_MS = 2_500;
const LIVE_SCHEDULE_STATUSES = new Set(["live", "started", "in_progress"]);
const PAST_SCHEDULE_STATUSES = new Set([
  "ended",
  "cancelled",
  "canceled",
  "completed",
  "expired",
]);
const CONNECTION_RANK: Record<ConnectionState, number> = {
  offline: 0,
  connecting: 1,
  reconnecting: 2,
  live: 3,
};

type RoomDetailState = {
  selection: RoomSelection;
  room: RoomSnapshot;
};

type RoomChatState = {
  selection: RoomSelection;
  messages: AdminChatMessage[];
};

const roomIdentity = (
  room: Pick<AdminRoomSummary, "channelId" | "clientId" | "roomId">,
): string => room.channelId || `${room.clientId}:${room.roomId}`;

const scheduledIdentity = (
  item: Pick<AdminScheduledItem, "kind" | "clientId" | "id">,
): string => `${item.kind}:${item.clientId}:${item.id}`;

const scheduleRoomIdentity = (
  item: Pick<AdminScheduledItem, "clientId" | "roomId">,
): string => `${item.clientId}:${item.roomId}`;

const roomScore = (room: TaggedRoomSummary): number =>
  room.participants * 1_000 +
  room.admins * 100 +
  room.pending * 10 +
  (room.screenShare ? 4 : 0) +
  (room.activeGame ? 2 : 0) +
  (room.activeAppId ? 1 : 0);

const scheduleStatusRank = (item: AdminScheduledItem): number => {
  const status = item.status.toLowerCase();
  if (LIVE_SCHEDULE_STATUSES.has(status)) return 3;
  if (PAST_SCHEDULE_STATUSES.has(status)) return 1;
  return 2;
};

const prefersRoom = (
  next: TaggedRoomSummary,
  current: TaggedRoomSummary,
  connectionByInstance: Map<string, ConnectionState>,
): boolean => {
  const nextConnection = CONNECTION_RANK[connectionByInstance.get(next.instanceKey) ?? "offline"];
  const currentConnection =
    CONNECTION_RANK[connectionByInstance.get(current.instanceKey) ?? "offline"];
  if (nextConnection !== currentConnection) return nextConnection > currentConnection;
  const nextScore = roomScore(next);
  const currentScore = roomScore(current);
  if (nextScore !== currentScore) return nextScore > currentScore;
  return next.instanceKey.localeCompare(current.instanceKey) < 0;
};

const prefersScheduledItem = (
  next: TaggedScheduledItem,
  current: TaggedScheduledItem,
  activeRoomByIdentity: Map<string, TaggedRoomSummary>,
  connectionByInstance: Map<string, ConnectionState>,
): boolean => {
  const activeRoom = activeRoomByIdentity.get(scheduleRoomIdentity(next));
  if (activeRoom) {
    if (next.instanceKey === activeRoom.instanceKey) return true;
    if (current.instanceKey === activeRoom.instanceKey) return false;
  }

  const nextRank = scheduleStatusRank(next);
  const currentRank = scheduleStatusRank(current);
  if (nextRank !== currentRank) return nextRank > currentRank;
  const nextConnection = CONNECTION_RANK[connectionByInstance.get(next.instanceKey) ?? "offline"];
  const currentConnection =
    CONNECTION_RANK[connectionByInstance.get(current.instanceKey) ?? "offline"];
  if (nextConnection !== currentConnection) return nextConnection > currentConnection;
  return next.instanceKey.localeCompare(current.instanceKey) < 0;
};

/**
 * Live data plane for the operator dashboard: one direct BROWSER to SFU
 * socket per instance in the pool. This runs client side only (inside an
 * effect), which is exactly what a serverless web tier needs: no WebSocket
 * ever touches a Next function. The only server involvement is the token mint
 * route, a plain request/response call gated by the operator allowlist; the
 * browser never sees the SFU secret and tokens are re-minted per connection
 * attempt so expiry never strands a session. Everything on screen streams in
 * from here; nothing polls.
 */
export function useAdminSocket() {
  const [instances, setInstances] = useState<InstanceStatus[]>([]);
  const [roomsByInstance, setRoomsByInstance] = useState<
    Record<string, AdminRoomSummary[]>
  >({});
  const [historyByInstance, setHistoryByInstance] = useState<
    Record<string, AdminHistoryPoint[]>
  >({});
  const [events, setEvents] = useState<TaggedAdminEvent[]>([]);
  const [audit, setAudit] = useState<TaggedAuditEntry[]>([]);
  const [scheduledByInstance, setScheduledByInstance] = useState<
    Record<string, AdminScheduledItem[]>
  >({});
  const [detail, setDetail] = useState<RoomDetailState | null>(null);
  const [roomChat, setRoomChat] = useState<RoomChatState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const socketsRef = useRef<Map<string, Socket>>(new Map());
  const watchedRef = useRef<RoomSelection | null>(null);

  useEffect(() => {
    let disposed = false;
    const sockets = new Map<string, Socket>();
    socketsRef.current = sockets;

    setBootError(null);
    setInstances([]);
    setRoomsByInstance({});
    setHistoryByInstance({});
    setEvents([]);
    setAudit([]);
    setScheduledByInstance({});
    setDetail(null);
    setRoomChat(null);

    const mint = async (): Promise<Array<{ url: string; token: string }>> => {
      const response = await fetch("/api/sfu/admin/socket", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          await readResponseError(response, "Not authorized for the SFU admin socket"),
        );
      }
      const data = (await response.json()) as {
        instances?: Array<{ url: string; token: string }>;
      };
      return Array.isArray(data.instances) ? data.instances : [];
    };

    const patchInstance = (key: string, patch: Partial<InstanceStatus>) => {
      setInstances((prev) =>
        prev.map((instance) =>
          instance.key === key ? { ...instance, ...patch } : instance,
        ),
      );
    };

    const clearInstanceLiveState = (key: string) => {
      setInstances((prev) =>
        prev.map((instance) =>
          instance.key === key ? { ...instance, overview: null } : instance,
        ),
      );
      setRoomsByInstance((prev) =>
        prev[key]?.length ? { ...prev, [key]: [] } : prev,
      );
      setScheduledByInstance((prev) =>
        prev[key]?.length ? { ...prev, [key]: [] } : prev,
      );
      setDetail((prev) =>
        prev?.selection.instanceKey === key ? null : prev,
      );
      setRoomChat((prev) =>
        prev?.selection.instanceKey === key ? null : prev,
      );
    };

    void (async () => {
      try {
        const minted = await mint();
        if (disposed) return;
        if (minted.length === 0) {
          setBootError("No SFU instances configured");
          return;
        }

        setInstances(
          minted.map(({ url }) => ({
            key: url,
            url,
            connection: "connecting",
            instanceId: null,
            overview: null,
          })),
        );

        for (const { url, token } of minted) {
          const key = url;
          let hasConnected = false;
          const socket = io(`${url}/admin`, {
            transports: ["websocket"],
            // A fresh token per attempt; fall back to the boot token if the
            // mint endpoint is briefly unreachable during a reconnect.
            auth: (setAuth) => {
              mint()
                .then((list) => {
                  const match = list.find((entry) => entry.url === url);
                  setAuth({ token: match?.token ?? token });
                })
                .catch(() => setAuth({ token }));
            },
          });
          sockets.set(key, socket);

          socket.on("connect", () => {
            hasConnected = true;
            patchInstance(key, { connection: "live" });
            const watched = watchedRef.current;
            if (watched) {
              socket.emit("admin:watchRoom", { channelId: watched.channelId });
            }
          });
          socket.on("disconnect", () => {
            patchInstance(key, {
              connection: hasConnected ? "reconnecting" : "offline",
            });
            clearInstanceLiveState(key);
          });
          socket.on("connect_error", () => {
            patchInstance(key, {
              connection: hasConnected ? "reconnecting" : "offline",
            });
            clearInstanceLiveState(key);
          });

          socket.on("admin:hello", (data: { instanceId?: string }) => {
            patchInstance(key, { instanceId: data?.instanceId ?? null });
          });
          socket.on("admin:overview", (data: ClusterOverview) => {
            patchInstance(key, { overview: data });
          });
          socket.on("admin:rooms", (data: { rooms?: AdminRoomSummary[] }) => {
            setRoomsByInstance((prev) => ({
              ...prev,
              [key]: Array.isArray(data?.rooms) ? data.rooms : [],
            }));
          });
          socket.on(
            "admin:room",
            (data: { channelId?: string; room?: RoomSnapshot | null }) => {
              const watched = watchedRef.current;
              if (
                !watched ||
                data?.channelId !== watched.channelId
              ) {
                return;
              }
              setDetail((prev) => {
                if (data.room) {
                  return {
                    selection: { instanceKey: key, channelId: data.channelId },
                    room: data.room,
                  };
                }
                if (
                  prev?.selection.instanceKey === key &&
                  prev.selection.channelId === data.channelId
                ) {
                  return null;
                }
                return prev;
              });
            },
          );
          socket.on("admin:history", (data: { points?: AdminHistoryPoint[] }) => {
            setHistoryByInstance((prev) => ({
              ...prev,
              [key]: Array.isArray(data?.points) ? data.points : [],
            }));
          });
          socket.on("admin:historyPoint", (point: AdminHistoryPoint) => {
            setHistoryByInstance((prev) => {
              const next = [...(prev[key] ?? []), point];
              if (next.length > 360) next.splice(0, next.length - 360);
              return { ...prev, [key]: next };
            });
          });
          socket.on(
            "admin:events",
            (data: {
              events?: Array<Omit<TaggedAdminEvent, "instanceKey">>;
              snapshot?: boolean;
            }) => {
              const incoming = Array.isArray(data?.events) ? data.events : [];
              const isSnapshot = data?.snapshot === true;
              if (incoming.length === 0 && !isSnapshot) return;
              setEvents((prev) => {
                const base = isSnapshot
                  ? prev.filter((event) => event.instanceKey !== key)
                  : prev;
                const next = [
                  ...base,
                  ...incoming.map((event) => ({ ...event, instanceKey: key })),
                ];
                next.sort((a, b) => a.at - b.at);
                if (next.length > EVENTS_CAP) {
                  next.splice(0, next.length - EVENTS_CAP);
                }
                return next;
              });
            },
          );
          socket.on(
            "admin:audit",
            (data: { entries?: Array<Omit<TaggedAuditEntry, "instanceKey">> }) => {
              const incoming = Array.isArray(data?.entries) ? data.entries : [];
              setAudit((prev) => {
                const others = prev.filter((entry) => entry.instanceKey !== key);
                const next = [
                  ...others,
                  ...incoming.map((entry) => ({ ...entry, instanceKey: key })),
                ];
                next.sort((a, b) => a.at - b.at);
                if (next.length > AUDIT_CAP) {
                  next.splice(0, next.length - AUDIT_CAP);
                }
                return next;
              });
            },
          );
          socket.on(
            "admin:chat",
            (data: { channelId?: string; messages?: AdminChatMessage[] }) => {
              const watched = watchedRef.current;
              if (
                !watched ||
                data?.channelId !== watched.channelId
              ) {
                return;
              }
              setRoomChat({
                selection: { instanceKey: key, channelId: data.channelId },
                messages: Array.isArray(data.messages) ? data.messages : [],
              });
            },
          );
          socket.on(
            "admin:scheduled",
            (data: { items?: AdminScheduledItem[] }) => {
              setScheduledByInstance((prev) => ({
                ...prev,
                [key]: Array.isArray(data?.items) ? data.items : [],
              }));
            },
          );
          socket.on(
            "admin:auditEntry",
            (entry: Omit<TaggedAuditEntry, "instanceKey">) => {
              setAudit((prev) => {
                const next = [...prev, { ...entry, instanceKey: key }];
                if (next.length > AUDIT_CAP) {
                  next.splice(0, next.length - AUDIT_CAP);
                }
                return next;
              });
            },
          );
        }
      } catch (error) {
        if (!disposed) {
          setBootError((error as Error).message);
        }
      }
    })();

    return () => {
      disposed = true;
      for (const socket of sockets.values()) {
        socket.close();
      }
      sockets.clear();
    };
  }, [retryNonce]);

  /**
   * Point the detail stream at one room (or null to stop watching). The
   * previous room's snapshot stays rendered until the new one arrives, so
   * switching rooms never blanks the pane.
   */
  const watchRoom = useCallback((selection: RoomSelection | null) => {
    const previous = watchedRef.current;
    watchedRef.current = selection;
    if (!selection) {
      setDetail(null);
      setRoomChat(null);
    }

    if (previous && (!selection || previous.channelId !== selection.channelId)) {
      for (const socket of socketsRef.current.values()) {
        socket.emit("admin:watchRoom", {});
      }
    }
    if (selection) {
      for (const socket of socketsRef.current.values()) {
        if (socket.connected) {
          socket.emit("admin:watchRoom", { channelId: selection.channelId });
        }
      }
    }
  }, []);

  /** Force a fresh detail push, e.g. to roll back an optimistic edit. */
  const resyncRoom = useCallback(() => {
    const watched = watchedRef.current;
    if (!watched) return;
    for (const socket of socketsRef.current.values()) {
      if (socket.connected) {
        socket.emit("admin:watchRoom", { channelId: watched.channelId });
      }
    }
  }, []);

  /** Search every connected instance for a person, merged and tagged. */
  const findUser = useCallback(
    async (query: string): Promise<TaggedFindMatch[]> => {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const lookups: Array<Promise<TaggedFindMatch[]>> = [];
      for (const [key, socket] of socketsRef.current) {
        if (!socket.connected) continue;
        lookups.push(
          socket
            .timeout(FIND_TIMEOUT_MS)
            .emitWithAck("admin:findUser", { query: trimmed })
            .then((response: { matches?: TaggedFindMatch[] }) =>
              (Array.isArray(response?.matches) ? response.matches : []).map(
                (match) => ({ ...match, instanceKey: key }),
              ),
            )
            .catch(() => [] as TaggedFindMatch[]),
        );
      }
      const results = await Promise.all(lookups);
      return results.flat();
    },
    [],
  );

  const retry = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);

  const connectionByInstance = useMemo(() => {
    const map = new Map<string, ConnectionState>();
    for (const instance of instances) {
      map.set(instance.key, instance.connection);
    }
    return map;
  }, [instances]);

  const rooms: TaggedRoomSummary[] = useMemo(() => {
    const byRoom = new Map<string, TaggedRoomSummary>();
    for (const instance of instances) {
      for (const room of roomsByInstance[instance.key] ?? []) {
        const tagged = {
          ...room,
          instanceKey: instance.key,
          instanceUrl: instance.url,
        };
        const key = roomIdentity(tagged);
        const existing = byRoom.get(key);
        if (!existing || prefersRoom(tagged, existing, connectionByInstance)) {
          byRoom.set(key, tagged);
        }
      }
    }
    return Array.from(byRoom.values());
  }, [connectionByInstance, instances, roomsByInstance]);

  const scheduled: TaggedScheduledItem[] = useMemo(() => {
    const activeRoomByIdentity = new Map<string, TaggedRoomSummary>();
    for (const room of rooms) {
      activeRoomByIdentity.set(`${room.clientId}:${room.roomId}`, room);
    }

    const byItem = new Map<string, TaggedScheduledItem>();
    for (const instance of instances) {
      for (const item of scheduledByInstance[instance.key] ?? []) {
        const tagged = { ...item, instanceKey: instance.key };
        const key = scheduledIdentity(tagged);
        const existing = byItem.get(key);
        if (
          !existing ||
          prefersScheduledItem(
            tagged,
            existing,
            activeRoomByIdentity,
            connectionByInstance,
          )
        ) {
          byItem.set(key, tagged);
        }
      }
    }
    const merged = Array.from(byItem.values());
    merged.sort((a, b) => a.startAt - b.startAt);
    return merged;
  }, [connectionByInstance, instances, rooms, scheduledByInstance]);

  const connection: ConnectionState = useMemo(() => {
    if (bootError) return "offline";
    if (instances.length === 0) return "connecting";
    if (instances.some((instance) => instance.connection === "live")) {
      return "live";
    }
    if (instances.some((instance) => instance.connection === "reconnecting")) {
      return "reconnecting";
    }
    if (instances.every((instance) => instance.connection === "offline")) {
      return "offline";
    }
    return "connecting";
  }, [bootError, instances]);

  /** Cross-pool participant history, index-aligned from the newest sample. */
  const participantsHistory: number[] = useMemo(() => {
    const series = instances
      .map((instance) => historyByInstance[instance.key] ?? [])
      .filter((points) => points.length > 0);
    if (series.length === 0) return [];
    const length = Math.max(...series.map((points) => points.length));
    const summed: number[] = [];
    for (let offset = length - 1; offset >= 0; offset -= 1) {
      let total = 0;
      for (const points of series) {
        const point = points[points.length - 1 - offset];
        if (point) total += point.participants;
      }
      summed.push(total);
    }
    return summed;
  }, [historyByInstance, instances]);

  return {
    connection,
    bootError,
    instances,
    rooms,
    roomDetail: detail?.room ?? null,
    detailSelection: detail?.selection ?? null,
    roomChat:
      roomChat &&
      detail &&
      roomChat.selection.instanceKey === detail.selection.instanceKey &&
      roomChat.selection.channelId === detail.selection.channelId
        ? roomChat.messages
        : null,
    events,
    audit,
    scheduled,
    participantsHistory,
    watchRoom,
    resyncRoom,
    findUser,
    retry,
  };
}
