"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { color, font } from "@conclave/ui-tokens";
import { readResponseError } from "../lib/utils";
import { ActivityDrawer } from "./ActivityDrawer";
import { AlertsStrip, type OperatorAlert } from "./AlertsStrip";
import { ConsolePanel } from "./ConsolePanel";
import { DashboardHeader } from "./DashboardHeader";
import { RoomsRail } from "./RoomsRail";
import { RoomView } from "./RoomView";
import { Toasts } from "./Toasts";
import type { AdminUser, RoomSelection } from "./types";
import { btnSecondary, inputClass } from "./ui";
import { useAdminActions } from "./useAdminActions";
import { useAdminSocket } from "./useAdminSocket";

/**
 * Operator dashboard, meeting-grade. All data streams in over direct
 * browser-to-SFU sockets (serverless friendly: the web tier only mints
 * tokens); commands ride the authenticated HTTP proxy and their effects
 * stream back within a second.
 */
export default function SfuAdminDashboard() {
  const {
    connection,
    bootError,
    instances,
    rooms,
    roomDetail,
    detailSelection,
    roomChat,
    events,
    audit,
    scheduled,
    participantsHistory,
    watchRoom,
    resyncRoom,
    findUser,
    retry,
  } = useAdminSocket();

  const {
    runAction,
    runBatch,
    isBusy,
    busyToast,
    errorMessage,
    statusMessage,
    setErrorMessage,
  } = useAdminActions();

  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
  const [selected, setSelected] = useState<RoomSelection | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/sfu/admin/auth", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readResponseError(response, "Not authorized"));
        }
        const data = (await response.json()) as { user: AdminUser };
        setAdminUser(data.user);
      })
      .catch((error) => setErrorMessage((error as Error).message));
  }, [setErrorMessage]);

  // Keep a valid selection: prefer what the operator picked, fall back to the
  // busiest room, clear when the floor empties.
  useEffect(() => {
    if (rooms.length === 0) {
      if (selected !== null) {
        setSelected(null);
        watchRoom(null);
      }
      return;
    }
    if (
      rooms.some(
        (room) =>
          room.instanceKey === selected?.instanceKey &&
          room.channelId === selected?.channelId,
      )
    ) {
      return;
    }
    const busiest = [...rooms].sort((a, b) => b.participants - a.participants)[0];
    const next = { instanceKey: busiest.instanceKey, channelId: busiest.channelId };
    setSelected(next);
    watchRoom(next);
  }, [rooms, selected, watchRoom]);

  useEffect(() => {
    if (
      detailSelection &&
      selected?.channelId === detailSelection.channelId &&
      selected.instanceKey !== detailSelection.instanceKey
    ) {
      setSelected(detailSelection);
    }
  }, [detailSelection, selected]);

  const selectRoom = useCallback(
    (selection: RoomSelection) => {
      setSelected(selection);
      watchRoom(selection);
    },
    [watchRoom],
  );

  // Operator shortcuts: "/" find a person, j and k cycle rooms in rail
  // order, "a" toggles the activity drawer. Never while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        target?.isContentEditable ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select"
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "/") {
        event.preventDefault();
        findInputRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        setActivityOpen(false);
        return;
      }
      if (event.key === "a") {
        setActivityOpen((prev) => !prev);
        return;
      }
      if (event.key === "j" || event.key === "k") {
        const ordered = [...rooms].sort(
          (a, b) => b.participants - a.participants || a.roomId.localeCompare(b.roomId),
        );
        if (ordered.length === 0) return;
        const index = ordered.findIndex(
          (room) =>
            room.instanceKey === selected?.instanceKey &&
            room.channelId === selected?.channelId,
        );
        const step = event.key === "j" ? 1 : -1;
        const nextIndex =
          index === -1 ? 0 : (index + step + ordered.length) % ordered.length;
        const next = ordered[nextIndex];
        selectRoom({ instanceKey: next.instanceKey, channelId: next.channelId });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rooms, selected, selectRoom]);

  // Alert rules over the live stream. Dismissals are per session and keyed,
  // so a condition that clears and returns will surface again after reload.
  const alerts = useMemo(() => {
    const list: OperatorAlert[] = [];
    for (const instance of instances) {
      const name = instance.instanceId ?? instance.url;
      if (instance.overview && instance.overview.workers.closed > 0) {
        list.push({
          key: `workers:${instance.key}`,
          message: `${name}: ${instance.overview.workers.closed} worker${
            instance.overview.workers.closed === 1 ? "" : "s"
          } down`,
        });
      }
      if (instance.overview?.draining) {
        list.push({ key: `draining:${instance.key}`, message: `${name} is draining` });
      }
    }
    for (const room of rooms) {
      if (room.pending > 0 && room.admins === 0) {
        list.push({
          key: `waiting:${room.instanceKey}:${room.channelId}`,
          message: `${room.roomId}: ${room.pending} waiting with no host`,
          selection: { instanceKey: room.instanceKey, channelId: room.channelId },
        });
      }
    }
    return list.filter((alert) => !dismissedAlerts.has(alert.key));
  }, [dismissedAlerts, instances, rooms]);

  // The room pane renders whatever detail the socket has confirmed; while a
  // switch is in flight it keeps showing the previous room instead of
  // flashing a loading state.
  const detailInstance = useMemo(
    () =>
      instances.find((instance) => instance.key === detailSelection?.instanceKey) ??
      null,
    [detailSelection, instances],
  );

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ backgroundColor: color.bg, color: color.text, fontFamily: font.sans }}
    >
      <header
        className="sticky top-0 z-20 border-b"
        style={{
          borderColor: color.border,
          backgroundColor: "rgba(10,10,11,0.92)",
          backdropFilter: "blur(8px)",
        }}
      >
        <DashboardHeader
          connection={connection}
          instances={instances}
          participantsHistory={participantsHistory}
          adminUser={adminUser}
          activityOpen={activityOpen}
          onToggleActivity={() => setActivityOpen((prev) => !prev)}
          findInputRef={findInputRef}
          onFindSearch={findUser}
          onFindPick={(match) =>
            selectRoom({ instanceKey: match.instanceKey, channelId: match.channelId })
          }
          isBusy={isBusy}
          runAction={runAction}
        />
        <AlertsStrip
          alerts={alerts}
          onJump={selectRoom}
          onDismiss={(key) =>
            setDismissedAlerts((prev) => new Set(prev).add(key))
          }
        />
      </header>

      <Toasts
        errorMessage={errorMessage}
        statusMessage={statusMessage}
        busyToast={busyToast}
        onDismissError={() => setErrorMessage(null)}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[300px_1fr]">
        <aside
          className="hidden max-h-[calc(100vh-48px)] border-r xl:block"
          style={{ borderColor: color.border }}
        >
          <RoomsRail
            rooms={rooms}
            instances={instances}
            selected={selected}
            onSelect={selectRoom}
          />
        </aside>

        <main
          className={`max-h-[calc(100vh-48px)] overflow-y-auto px-4 transition-[margin] duration-[120ms] md:px-8 ${
            activityOpen ? "xl:mr-[360px]" : ""
          }`}
        >
          {/* Small screens still need room switching */}
          <div className="py-3 xl:hidden">
            <select
              className={inputClass}
              value={selected ? `${selected.instanceKey}\n${selected.channelId}` : ""}
              onChange={(event) => {
                const [instanceKey, channelId] = event.target.value.split("\n");
                if (instanceKey && channelId) selectRoom({ instanceKey, channelId });
              }}
            >
              {rooms.map((room) => (
                <option
                  key={`${room.instanceKey}:${room.channelId}`}
                  value={`${room.instanceKey}\n${room.channelId}`}
                >
                  {room.roomId} ({room.participants})
                </option>
              ))}
            </select>
          </div>

          {connection === "offline" ? (
            <CenterNote
              title="Not connected"
              body={bootError || "Can't reach the SFU."}
              action={
                <button type="button" className={btnSecondary} onClick={retry}>
                  Try again
                </button>
              }
            />
          ) : rooms.length === 0 ? (
            <CenterNote
              title={connection === "live" ? "No active rooms" : "Connecting"}
              body={
                connection === "live"
                  ? "Rooms appear when someone joins."
                  : bootError || "Connecting to the SFU."
              }
            />
          ) : !roomDetail || !detailInstance ? (
            <CenterNote title="Loading room" body="Waiting for the snapshot." />
          ) : (
            <div className="pt-3">
              <RoomView
                room={roomDetail}
                chat={roomChat}
                instanceUrl={detailInstance.url}
                isBusy={isBusy}
                runAction={runAction}
                runBatch={runBatch}
                onActionSettled={resyncRoom}
              />
              <div className="mx-auto w-full max-w-6xl pb-10">
                <ConsolePanel
                  room={{ id: roomDetail.id, clientId: roomDetail.clientId }}
                  instanceUrl={detailInstance.url}
                />
              </div>
            </div>
          )}
        </main>
      </div>

      <ActivityDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        events={events}
        audit={audit}
        scheduled={scheduled}
        rooms={rooms}
        selected={selected}
        instances={instances}
        onPickRoom={(instanceKey, channelId) => selectRoom({ instanceKey, channelId })}
      />
    </div>
  );
}

function CenterNote({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
      <p className="text-[15px] font-medium" style={{ color: color.text }}>
        {title}
      </p>
      <p className="max-w-[320px] text-[12.5px] leading-relaxed" style={{ color: color.textFaint }}>
        {body}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
