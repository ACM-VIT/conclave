"use client";

import { useState } from "react";
import { color } from "@conclave/ui-tokens";
import { FindPerson } from "./FindPerson";
import { WorkersList } from "./WorkersList";
import type {
  AdminActionInput,
  AdminUser,
  ConnectionState,
  InstanceStatus,
  TaggedFindMatch,
} from "./types";
import {
  ConfirmButton,
  Dot,
  Popover,
  Sparkline,
  Toggle,
  btnSecondary,
  inputClass,
} from "./ui";

const formatUptime = (seconds: number): string => {
  const rounded = Math.max(0, Math.floor(seconds));
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor((rounded % 86400) / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

const CONNECTION_TONE: Record<ConnectionState, string> = {
  connecting: color.warning,
  live: color.success,
  reconnecting: color.warning,
  offline: color.danger,
};

/**
 * Command bar: connection state, pool stats, the one-hour trend, person
 * search, activity toggle, and per-instance controls. Drain drafts live here
 * because nothing else needs them.
 */
export function DashboardHeader({
  connection,
  instances,
  participantsHistory,
  adminUser,
  activityOpen,
  onToggleActivity,
  findInputRef,
  onFindSearch,
  onFindPick,
  isBusy,
  runAction,
}: {
  connection: ConnectionState;
  instances: InstanceStatus[];
  participantsHistory: number[];
  adminUser: AdminUser | null;
  activityOpen: boolean;
  onToggleActivity: () => void;
  findInputRef: React.Ref<HTMLInputElement>;
  onFindSearch: (query: string) => Promise<TaggedFindMatch[]>;
  onFindPick: (match: TaggedFindMatch) => void;
  isBusy: boolean;
  runAction: (input: AdminActionInput) => Promise<boolean>;
}) {
  const [drainForce, setDrainForce] = useState(false);
  const [drainNotice, setDrainNotice] = useState(
    "Meeting server is restarting. You will be reconnected automatically.",
  );

  let roomsCount = 0;
  let people = 0;
  let workersHealthy = 0;
  let workersTotal = 0;
  for (const instance of instances) {
    if (!instance.overview) continue;
    roomsCount += instance.overview.counts.rooms;
    people += instance.overview.counts.participants;
    workersHealthy += instance.overview.workers.healthy;
    workersTotal += instance.overview.workers.total;
  }
  const anyDraining = instances.some((instance) => instance.overview?.draining);

  return (
    <div className="flex h-12 items-center gap-3 px-4">
      <h1 className="shrink-0 text-[14px] font-semibold">SFU admin</h1>
      <span
        className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium"
        style={{ color: CONNECTION_TONE[connection] }}
      >
        <Dot tone={CONNECTION_TONE[connection]} />
        {CONNECTION_LABEL[connection]}
      </span>
      {instances.length > 1 ? (
        <span className="hidden shrink-0 items-center gap-1.5 md:flex">
          {instances.map((instance) => (
            <span
              key={instance.key}
              title={`${instance.instanceId ?? instance.url} · ${instance.connection}`}
            >
              <Dot tone={CONNECTION_TONE[instance.connection]} />
            </span>
          ))}
        </span>
      ) : null}

      <div className="ml-auto flex min-w-0 items-center gap-3">
        {participantsHistory.length >= 6 ? (
          <span className="hidden lg:block" title="People across the pool, last hour">
            <Sparkline values={participantsHistory} />
          </span>
        ) : null}
        {instances.length > 0 ? (
          <span
            className="hidden shrink-0 text-[12px] md:inline"
            style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
          >
            {roomsCount} rooms · {people} people · workers {workersHealthy}/{workersTotal}
          </span>
        ) : null}

        <FindPerson inputRef={findInputRef} onSearch={onFindSearch} onPick={onFindPick} />

        <button
          type="button"
          className={btnSecondary}
          onClick={onToggleActivity}
          aria-pressed={activityOpen}
          title="Activity and audit ( a )"
        >
          Activity
        </button>

        <Popover label="Instances" active={anyDraining} width={340}>
          <div className="space-y-2">
            {instances.map((instance) => {
              const draining = Boolean(instance.overview?.draining);
              const name = instance.instanceId ?? instance.url;
              const overview = instance.overview;
              return (
                <div
                  key={instance.key}
                  className="rounded-lg border px-3 py-2.5"
                  style={{ borderColor: color.border, backgroundColor: color.surface }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Dot tone={CONNECTION_TONE[instance.connection]} />
                      <p className="truncate text-[13px] font-medium" style={{ color: color.text }}>
                        {name}
                      </p>
                      {draining ? (
                        <span className="text-[11px] font-medium" style={{ color: color.warning }}>
                          draining
                        </span>
                      ) : null}
                    </div>
                    <ConfirmButton
                      size="tiny"
                      label={draining ? "Stop drain" : "Drain"}
                      confirmLabel="Confirm"
                      disabled={isBusy}
                      onConfirm={() =>
                        void runAction({
                          label: draining
                            ? `Stopped draining ${name}`
                            : `Started draining ${name}`,
                          path: "drain",
                          instanceUrl: instance.url,
                          body: {
                            draining: !draining,
                            force: drainForce,
                            notice: drainNotice.trim() || undefined,
                            noticeMs: 4000,
                          },
                        })
                      }
                    />
                  </div>
                  <p
                    className="mt-1 truncate text-[11px]"
                    style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
                  >
                    {overview
                      ? `${overview.counts.rooms} rooms · ${overview.counts.participants} people · workers ${overview.workers.healthy}/${overview.workers.total} · v${overview.version} · up ${formatUptime(overview.uptime)}`
                      : CONNECTION_LABEL[instance.connection]}
                  </p>
                  <div className="mt-1.5">
                    <WorkersList instanceUrl={instance.url} />
                  </div>
                </div>
              );
            })}
            {instances.length === 0 ? (
              <p className="py-2 text-center text-[12px]" style={{ color: color.textFaint }}>
                No instances yet
              </p>
            ) : null}

            <details>
              <summary
                className="cursor-pointer select-none text-[11.5px] transition-colors hover:text-white"
                style={{ color: color.textFaint }}
              >
                Drain options
              </summary>
              <div className="mt-2 space-y-2">
                <Toggle
                  label="Force disconnect on drain"
                  checked={drainForce}
                  onChange={setDrainForce}
                />
                <input
                  className={inputClass}
                  value={drainNotice}
                  onChange={(event) => setDrainNotice(event.target.value)}
                  placeholder="Restart notice"
                />
              </div>
            </details>
          </div>
        </Popover>

        <span
          className="hidden max-w-[160px] truncate text-[12px] xl:inline"
          style={{ color: color.textFaint }}
        >
          {adminUser?.email || adminUser?.id || ""}
        </span>
      </div>
    </div>
  );
}
