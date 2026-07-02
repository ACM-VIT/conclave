"use client";

import { useMemo, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type { InstanceStatus, RoomSelection, TaggedRoomSummary } from "./types";
import { Tag, inputClass } from "./ui";

/**
 * Left rail: every active room across the whole pool, streamed live. Tenant
 * chips and search filter locally; the sockets always carry the full picture.
 */
export function RoomsRail({
  rooms,
  instances,
  selected,
  onSelect,
}: {
  rooms: TaggedRoomSummary[];
  instances: InstanceStatus[];
  selected: RoomSelection | null;
  onSelect: (selection: RoomSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const multiInstance = instances.length > 1;

  const instanceLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const instance of instances) {
      labels.set(instance.key, instance.instanceId ?? instance.url);
    }
    return labels;
  }, [instances]);

  const clientChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const room of rooms) {
      counts.set(room.clientId, (counts.get(room.clientId) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [rooms]);

  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rooms
      .filter((room) => (clientFilter ? room.clientId === clientFilter : true))
      .filter((room) =>
        normalized
          ? room.roomId.toLowerCase().includes(normalized) ||
            room.clientId.toLowerCase().includes(normalized)
          : true,
      )
      .sort(
        (a, b) =>
          b.participants - a.participants || a.roomId.localeCompare(b.roomId),
      );
  }, [clientFilter, query, rooms]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-3">
        <input
          className={inputClass}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search rooms"
        />
        {clientChips.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            <ChipButton
              active={clientFilter === ""}
              label="All"
              count={rooms.length}
              onClick={() => setClientFilter("")}
            />
            {clientChips.map(([chipClientId, count]) => (
              <ChipButton
                key={chipClientId}
                active={clientFilter === chipClientId}
                label={chipClientId}
                count={count}
                onClick={() =>
                  setClientFilter((prev) => (prev === chipClientId ? "" : chipClientId))
                }
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRooms.map((room) => {
          const isSelected =
            selected?.instanceKey === room.instanceKey &&
            selected?.channelId === room.channelId;
          return (
            <button
              key={`${room.instanceKey}:${room.channelId}`}
              type="button"
              onClick={() =>
                onSelect({ instanceKey: room.instanceKey, channelId: room.channelId })
              }
              className="relative block w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
              style={{
                backgroundColor: isSelected ? color.surface : "transparent",
              }}
            >
              {isSelected ? (
                <span
                  className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-full"
                  style={{ backgroundColor: color.accent }}
                  aria-hidden
                />
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-[13px] font-medium"
                  style={{ color: color.text }}
                >
                  {room.roomId}
                </span>
                <span
                  className="shrink-0 text-[12.5px] font-medium"
                  style={{
                    color: room.participants > 0 ? color.text : color.textFaint,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {room.participants}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Tag>{room.clientId}</Tag>
                {multiInstance ? (
                  <Tag>{instanceLabel.get(room.instanceKey) ?? room.instanceKey}</Tag>
                ) : null}
                {room.pending > 0 ? <Tag tone="warn">{room.pending} waiting</Tag> : null}
                {room.locked ? <Tag tone="accent">locked</Tag> : null}
                {room.screenShare ? <Tag tone="ok">screen</Tag> : null}
                {room.activeGame ? (
                  <Tag tone="accent">{room.activeGame}</Tag>
                ) : room.activeAppId ? (
                  <Tag tone="accent">{room.activeAppId}</Tag>
                ) : null}
              </div>
            </button>
          );
        })}

        {visibleRooms.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12.5px]" style={{ color: color.textFaint }}>
            {rooms.length === 0 ? "No active rooms" : "No rooms match"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChipButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors"
      style={{
        borderColor: active ? "rgba(249,95,74,0.5)" : color.border,
        color: active ? color.accent : color.textMuted,
        backgroundColor: active ? "rgba(249,95,74,0.08)" : "transparent",
      }}
      title={label}
    >
      <span className="truncate">{label}</span>
      <span
        style={{
          color: active ? color.accent : color.textFaint,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </span>
    </button>
  );
}
