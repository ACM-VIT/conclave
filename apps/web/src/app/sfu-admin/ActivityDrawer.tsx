"use client";

import { useEffect, useMemo, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type {
  AdminEventType,
  InstanceStatus,
  RoomSelection,
  TaggedAdminEvent,
  TaggedAuditEntry,
  TaggedRoomSummary,
  TaggedScheduledItem,
} from "./types";
import { Dot, Tag, btnTiny } from "./ui";

const EVENT_TONE: Record<AdminEventType, string> = {
  "room-opened": color.success,
  "room-closed": color.textFaint,
  "user-joined": color.success,
  "user-left": color.textFaint,
  "screen-started": color.accent,
  "screen-stopped": color.textFaint,
  "room-locked": color.warning,
  "room-unlocked": color.textFaint,
  waiting: color.warning,
};

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatWhen = (at: number): string =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** "in 2h 15m", "in 5m", "12m ago", "now". */
const formatRelative = (at: number, now: number): string => {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "now";
  const minutes = Math.round(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const label =
    days > 0
      ? `${days}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`
      : hours > 0
        ? `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`
        : `${minutes}m`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
};

const PAST_STATUSES = new Set(["ended", "cancelled", "canceled", "completed", "expired"]);
const LIVE_STATUSES = new Set(["live", "started", "in_progress"]);

const eventIdentity = (event: TaggedAdminEvent): string =>
  [
    event.at,
    event.channelId,
    event.type,
    event.message,
  ].join(":");

const findScheduledRoom = (
  item: TaggedScheduledItem,
  rooms: TaggedRoomSummary[],
): TaggedRoomSummary | null =>
  rooms.find(
    (room) =>
      room.instanceKey === item.instanceKey &&
      room.roomId === item.roomId &&
      room.clientId === item.clientId,
  ) ?? null;

function CopyLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={btnTiny}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(`${window.location.origin}${path}`)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

/**
 * The live floor journal: activity, the operator audit trail, and the
 * scheduling calendar. Streams in over the admin sockets.
 */
export function ActivityDrawer({
  open,
  onClose,
  events,
  audit,
  scheduled,
  rooms,
  selected,
  instances,
  onPickRoom,
}: {
  open: boolean;
  onClose: () => void;
  events: TaggedAdminEvent[];
  audit: TaggedAuditEntry[];
  scheduled: TaggedScheduledItem[];
  rooms: TaggedRoomSummary[];
  selected: RoomSelection | null;
  instances: InstanceStatus[];
  onPickRoom: (instanceKey: string, channelId: string) => void;
}) {
  const [view, setView] = useState<"activity" | "audit" | "scheduled">("activity");
  const [onlySelectedRoom, setOnlySelectedRoom] = useState(false);
  const multiInstance = instances.length > 1;

  const instanceLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const instance of instances) {
      labels.set(instance.key, instance.instanceId ?? instance.url);
    }
    return labels;
  }, [instances]);

  const visibleEvents = useMemo(() => {
    const scoped =
      onlySelectedRoom && selected
        ? events.filter((event) => event.channelId === selected.channelId)
        : events;
    const seen = new Map<string, string>();
    return scoped.filter((event) => {
      const key = eventIdentity(event);
      const instanceKey = seen.get(key);
      if (instanceKey && instanceKey !== event.instanceKey) return false;
      seen.set(key, event.instanceKey);
      return true;
    });
  }, [events, onlySelectedRoom, selected]);

  const scheduledGroups = useMemo(() => {
    const now = Date.now();
    const live: TaggedScheduledItem[] = [];
    const upcoming: TaggedScheduledItem[] = [];
    const past: TaggedScheduledItem[] = [];
    for (const item of scheduled) {
      const status = item.status.toLowerCase();
      const activeRoom = findScheduledRoom(item, rooms);
      if (LIVE_STATUSES.has(status) || activeRoom) {
        live.push(item);
      } else if (PAST_STATUSES.has(status) || item.endAt < now) {
        past.push(item);
      } else {
        upcoming.push(item);
      }
    }
    upcoming.sort((a, b) => a.startAt - b.startAt);
    past.sort((a, b) => b.startAt - a.startAt);
    return { live, upcoming, past, now };
  }, [rooms, scheduled]);

  if (!open) return null;

  const renderScheduledItem = (item: TaggedScheduledItem, now: number) => {
    const status = item.status.toLowerCase();
    const activeRoom = findScheduledRoom(item, rooms);
    const tone = activeRoom || LIVE_STATUSES.has(status)
      ? color.success
      : PAST_STATUSES.has(status)
        ? (color.textFaint as string)
        : color.warning;
    const linkPath = item.kind === "webinar" && item.slug
      ? `/w/${encodeURIComponent(item.slug)}`
      : `/${encodeURIComponent(item.roomId)}`;

    return (
      <div
        key={`${item.kind}-${item.clientId}-${item.id}`}
        className="rounded-lg border px-2.5 py-2"
        style={{ borderColor: color.border, backgroundColor: color.surface }}
      >
        <div className="flex items-start justify-between gap-2">
          <p
            className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug"
            style={{
              color: color.text,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {item.title}
          </p>
          <Tag>{item.kind}</Tag>
        </div>
        <p
          className="mt-1 flex items-center gap-1.5 text-[11px]"
          style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
        >
          <Dot tone={tone} />
          <span style={{ color: tone }}>{item.status}</span>
          <span>
            {formatRelative(item.startAt, now)} · {formatWhen(item.startAt)}
          </span>
        </p>
        <p className="mt-0.5 truncate text-[11px]" style={{ color: color.textFaint }}>
          {item.host} · {item.clientId}
          {multiInstance
            ? ` · ${instanceLabel.get(item.instanceKey) ?? item.instanceKey}`
            : ""}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {activeRoom ? (
            <button
              type="button"
              className={btnTiny}
              style={{ color: color.success, borderColor: "rgba(34,197,94,0.35)" }}
              onClick={() => onPickRoom(activeRoom.instanceKey, activeRoom.channelId)}
            >
              Live · {activeRoom.participants} in room
            </button>
          ) : null}
          <CopyLinkButton path={linkPath} />
        </div>
      </div>
    );
  };

  return (
    <aside
      className="fixed bottom-0 right-0 top-12 z-30 flex w-[min(360px,92vw)] flex-col border-l"
      style={{ borderColor: color.border, backgroundColor: color.bgAlt }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: color.border }}
      >
        <div className="flex gap-1">
          {(
            [
              ["activity", "Activity"],
              ["audit", "Audit"],
              ["scheduled", "Scheduled"],
            ] as const
          ).map(([id, label]) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className="rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors"
                style={{
                  color: active ? color.accent : color.textMuted,
                  backgroundColor: active ? "rgba(249,95,74,0.08)" : "transparent",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close activity"
          className="rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-white/[0.06]"
          style={{ color: color.textFaint }}
        >
          ×
        </button>
      </div>

      {view === "activity" && selected ? (
        <div className="border-b px-3 py-1.5" style={{ borderColor: color.border }}>
          <button
            type="button"
            onClick={() => setOnlySelectedRoom((prev) => !prev)}
            className="inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium transition-colors"
            style={{
              borderColor: onlySelectedRoom ? "rgba(249,95,74,0.5)" : color.border,
              color: onlySelectedRoom ? color.accent : color.textMuted,
              backgroundColor: onlySelectedRoom ? "rgba(249,95,74,0.08)" : "transparent",
            }}
          >
            This room only
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view === "activity" ? (
          visibleEvents.length === 0 ? (
            <EmptyNote text="Quiet so far." />
          ) : (
            <ul className="space-y-0.5">
              {[...visibleEvents].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onPickRoom(event.instanceKey, event.channelId)}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="mt-[5px]">
                      <Dot tone={EVENT_TONE[event.type] ?? (color.textFaint as string)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px]" style={{ color: color.textMuted }}>
                        {event.message}
                      </span>
                      <span
                        className="block text-[10.5px]"
                        style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
                      >
                        {formatClock(event.at)}
                        {multiInstance
                          ? ` · ${instanceLabel.get(event.instanceKey) ?? event.instanceKey}`
                          : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : view === "scheduled" ? (
          scheduled.length === 0 ? (
            <EmptyNote text="Nothing scheduled." />
          ) : (
            <div className="space-y-3">
              {scheduledGroups.live.length > 0 ? (
                <ScheduledGroup title="Live">
                  {scheduledGroups.live.map((item) =>
                    renderScheduledItem(item, scheduledGroups.now),
                  )}
                </ScheduledGroup>
              ) : null}
              {scheduledGroups.upcoming.length > 0 ? (
                <ScheduledGroup title="Upcoming">
                  {scheduledGroups.upcoming.map((item) =>
                    renderScheduledItem(item, scheduledGroups.now),
                  )}
                </ScheduledGroup>
              ) : null}
              {scheduledGroups.past.length > 0 ? (
                <details>
                  <summary
                    className="cursor-pointer select-none px-0.5 text-[11px] font-medium transition-colors hover:text-white"
                    style={{ color: color.textFaint }}
                  >
                    Past · {scheduledGroups.past.length}
                  </summary>
                  <div className="mt-2 space-y-2 opacity-70">
                    {scheduledGroups.past.map((item) =>
                      renderScheduledItem(item, scheduledGroups.now),
                    )}
                  </div>
                </details>
              ) : null}
            </div>
          )
        ) : audit.length === 0 ? (
          <EmptyNote text="No operator actions yet." />
        ) : (
          <ul className="space-y-0.5">
            {[...audit].reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="rounded-lg px-2 py-1.5">
                <p className="truncate text-[12.5px]" style={{ color: color.textMuted }}>
                  <span style={{ color: color.text }}>{entry.operator}</span>{" "}
                  {entry.method} {entry.path.replace(/^\/admin\//, "")}
                </p>
                <p
                  className="text-[10.5px]"
                  style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
                >
                  {formatClock(entry.at)}
                  {multiInstance
                    ? ` · ${instanceLabel.get(entry.instanceKey) ?? entry.instanceKey}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ScheduledGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 px-0.5 text-[11px] font-medium" style={{ color: color.textFaint }}>
        {title}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <p className="px-2 py-8 text-center text-[12px] leading-relaxed" style={{ color: color.textFaint }}>
      {text}
    </p>
  );
}
