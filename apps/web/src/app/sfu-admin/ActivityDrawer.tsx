"use client";

import { useMemo, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type {
  AdminEventType,
  InstanceStatus,
  TaggedAdminEvent,
  TaggedAuditEntry,
  TaggedScheduledItem,
} from "./types";
import { Dot, Tag } from "./ui";

const EVENT_TONE: Record<AdminEventType, string> = {
  "room-opened": color.success,
  "room-closed": color.textFaint as string,
  "user-joined": color.success,
  "user-left": color.textFaint as string,
  "screen-started": color.accent,
  "screen-stopped": color.textFaint as string,
  "room-locked": color.warning,
  "room-unlocked": color.textFaint as string,
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

const scheduledTone = (status: string): string => {
  if (status === "live" || status === "started") return color.success;
  if (status === "scheduled" || status === "upcoming") return color.warning;
  return color.textFaint as string;
};

/**
 * The live floor journal: joins, leaves, screens, locks on one side and the
 * operator audit trail on the other. Streams in over the admin sockets.
 */
export function ActivityDrawer({
  open,
  onClose,
  events,
  audit,
  scheduled,
  instances,
  onPickRoom,
}: {
  open: boolean;
  onClose: () => void;
  events: TaggedAdminEvent[];
  audit: TaggedAuditEntry[];
  scheduled: TaggedScheduledItem[];
  instances: InstanceStatus[];
  onPickRoom: (instanceKey: string, channelId: string) => void;
}) {
  const [view, setView] = useState<"activity" | "audit" | "scheduled">("activity");
  const multiInstance = instances.length > 1;

  const instanceLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const instance of instances) {
      labels.set(instance.key, instance.instanceId ?? instance.url);
    }
    return labels;
  }, [instances]);

  if (!open) return null;

  return (
    <aside
      className="fixed bottom-0 right-0 top-12 z-30 flex w-[min(340px,90vw)] flex-col border-l"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view === "activity" ? (
          events.length === 0 ? (
            <EmptyNote text="Quiet so far." />
          ) : (
            <ul className="space-y-0.5">
              {[...events].reverse().map((event, index) => (
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
            <ul className="space-y-0.5">
              {scheduled.map((item) => (
                <li
                  key={`${item.instanceKey}-${item.kind}-${item.id}`}
                  className="rounded-lg px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <p className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: color.text }}>
                      {item.title}
                    </p>
                    <Tag>{item.kind}</Tag>
                  </div>
                  <p
                    className="mt-0.5 text-[10.5px]"
                    style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
                  >
                    <span style={{ color: scheduledTone(item.status) }}>{item.status}</span>
                    {` · ${formatWhen(item.startAt)} · ${item.roomId}`}
                    {` · ${item.host}`}
                    {multiInstance
                      ? ` · ${instanceLabel.get(item.instanceKey) ?? item.instanceKey}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )
        ) : audit.length === 0 ? (
          <EmptyNote text="No operator actions yet." />
        ) : (
          <ul className="space-y-0.5">
            {[...audit].reverse().map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="rounded-lg px-2 py-1.5"
              >
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

function EmptyNote({ text }: { text: string }) {
  return (
    <p className="px-2 py-8 text-center text-[12px] leading-relaxed" style={{ color: color.textFaint }}>
      {text}
    </p>
  );
}
