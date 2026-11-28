"use client";

import React, { useState } from "react";
import { Blocks, ChevronRight, ExternalLink, LoaderCircle } from "lucide-react";
import {
  useApps,
  type AppsCommandResult,
  type AppsState,
} from "@conclave/apps-sdk";
import { color } from "@conclave/ui-tokens";
import {
  GAME_DOCK_HEADER_CLASS,
  GAME_DOCK_PANEL_CLASS,
  GAME_DOCK_TITLE_CLASS,
  GameDockCloseButton,
  GameDockResizeHandle,
  HEAD_FONT,
} from "../games/gameUi";
import PanelNoticeSlot from "../PanelNoticeSlot";

/**
 * An app that opens beside the call for this viewer alone. Opening one
 * changes nothing for anyone else and leaves the stage as it is.
 */
export type PanelAppEntry = {
  id: string;
  name: string;
  icon: React.ReactNode;
  isOpen: boolean;
  /** Something in the app is waiting for this viewer. */
  needsAttention?: boolean;
  /**
   * The server cannot run this app: it is an older one, or has such apps
   * turned off. The app is listed all the same, switched off, with the
   * reason, so its absence is explained.
   */
  needsServerUpdate?: boolean;
  onToggle: () => void;
};

const NEEDS_SERVER_UPDATE = "Needs a server update";

const commandFailureCopy = (result: AppsCommandResult): string | null => {
  if (result.ok) return null;
  return result.reason === "roomFull"
    ? "Too many saved apps. Clear one to present another."
    : "That did not go through. Try again.";
};

const APPS_SDK_DOCS_URL =
  "https://github.com/ACM-VIT/conclave/blob/main/packages/apps-sdk/docs/guides/add-a-new-app-integration.md";

export function AppsPanel({
  onClose,
  panelApps = [],
  rightOffset = 0,
  dockWidth,
  maxDockWidth,
  onDockWidthChange,
}: {
  onClose: () => void;
  panelApps?: PanelAppEntry[];
  rightOffset?: number;
  dockWidth?: number;
  maxDockWidth?: number;
  onDockWidthChange?: (width: number) => void;
}) {
  const {
    apps,
    state,
    presentApp,
    closeApp,
    clearApp,
    setLocked,
    isAdmin,
    isReadOnly,
  } = useApps();
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  // The confirm step is armed for one app against one room state, so any
  // change in between, including a move to another room, asks again.
  const [confirmingClear, setConfirmingClear] = useState<{
    appId: string;
    state: AppsState;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = Boolean(isAdmin) && !isReadOnly;
  const stageNote = isReadOnly
    ? "Observers can't present"
    : canManage
      ? null
      : "Host only";

  const run = async (
    appId: string,
    action: () => Promise<AppsCommandResult>,
  ) => {
    setBusyAppId(appId);
    setError(null);
    const result = await action();
    setBusyAppId(null);
    setError(commandFailureCopy(result));
  };

  const handlePick = (appId: string) => {
    if (!canManage || busyAppId) return;
    const isActive = state.activeAppId === appId;
    void run(appId, () => (isActive ? closeApp() : presentApp(appId)));
  };

  const isConfirmingClear = (appId: string) =>
    confirmingClear?.appId === appId && confirmingClear.state === state;

  const handleClear = (appId: string) => {
    if (!canManage || busyAppId) return;
    if (!isConfirmingClear(appId)) {
      setConfirmingClear({ appId, state });
      return;
    }
    setConfirmingClear(null);
    void run(appId, () => clearApp(appId));
  };

  return (
    <aside
      className={GAME_DOCK_PANEL_CLASS}
      style={{ right: rightOffset, width: dockWidth, fontFamily: HEAD_FONT }}
      aria-label="Apps"
    >
      <GameDockResizeHandle
        width={dockWidth}
        maxWidth={maxDockWidth}
        onWidthChange={onDockWidthChange}
      />
      <div className={GAME_DOCK_HEADER_CLASS}>
        <h2 className={GAME_DOCK_TITLE_CLASS}>Apps</h2>
        <GameDockCloseButton onClose={onClose} label="Close apps" />
      </div>

      <PanelNoticeSlot />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {panelApps.length > 0 && (
          <section className="mb-5" aria-labelledby="apps-panel-side">
            <h3 id="apps-panel-side" className={SECTION_LABEL_CLASS}>
              Side panel
            </h3>
            <div className="flex flex-col gap-1">
              {panelApps.map((app) => {
                const muted = Boolean(app.needsServerUpdate);
                const status = muted
                  ? NEEDS_SERVER_UPDATE
                  : app.needsAttention && !app.isOpen
                    ? "New"
                    : null;
                return (
                  <button
                    key={app.id}
                    type="button"
                    data-testid={`panel-app-${app.id}`}
                    disabled={muted}
                    title={muted ? NEEDS_SERVER_UPDATE : undefined}
                    onClick={app.onToggle}
                    aria-pressed={muted ? undefined : app.isOpen}
                    aria-label={
                      muted
                        ? `${app.name}: ${NEEDS_SERVER_UPDATE.toLowerCase()}`
                        : app.isOpen
                          ? `Close ${app.name}`
                          : `Open ${app.name}`
                    }
                    className={`${ROW_CLASS} cursor-pointer gap-3 px-2.5 py-2 text-left disabled:cursor-default ${
                      muted ? "" : "bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                    style={{
                      borderColor: app.isOpen ? color.accent : "transparent",
                    }}
                  >
                    <AppIcon tone={muted ? "muted" : app.isOpen ? "active" : "idle"}>
                      {app.icon}
                    </AppIcon>
                    <span
                      className="min-w-0 flex-1 truncate text-[14px] font-medium"
                      style={{ color: muted ? "#a1a1aa" : "#fafafa" }}
                    >
                      {app.name}
                    </span>
                    {status && (
                      <span
                        className="max-w-[55%] shrink-0 truncate text-[12px]"
                        style={{
                          color:
                            status === "New" ? color.accent : "#a1a1aa",
                        }}
                      >
                        {status}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section aria-labelledby="apps-panel-stage">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="apps-panel-stage" className={SECTION_LABEL_CLASS}>
              On stage
            </h3>
            {stageNote && (
              <span className="min-w-0 truncate text-[11.5px] text-[#71717a]">
                {stageNote}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {apps.map((app) => {
              const isActive = state.activeAppId === app.id;
              const isSaved = state.savedAppIds.includes(app.id);
              const isBusy = busyAppId === app.id;
              const interactive = canManage && !busyAppId;
              const confirming = isConfirmingClear(app.id);
              const canClear = canManage && isSaved && !isBusy;
              return (
                <div
                  key={app.id}
                  className={`${ROW_CLASS} group bg-white/[0.03] ${
                    interactive ? "hover:bg-white/[0.06]" : ""
                  }`}
                  style={{
                    borderColor: isActive ? color.accent : "transparent",
                  }}
                  onMouseLeave={() => {
                    if (confirming) setConfirmingClear(null);
                  }}
                >
                  <button
                    type="button"
                    disabled={!interactive}
                    onClick={() => handlePick(app.id)}
                    aria-label={
                      isActive ? `Close ${app.name}` : `Present ${app.name}`
                    }
                    className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-[inherit] px-2.5 py-2 text-left disabled:cursor-default"
                    style={{ cursor: interactive ? "pointer" : "default" }}
                  >
                    <AppIcon tone={isActive ? "active" : "idle"}>
                      {app.icon ?? <Blocks size={17} strokeWidth={1.75} />}
                    </AppIcon>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-medium text-[#fafafa]">
                        {app.name}
                      </span>
                      {isSaved && (
                        <span className="truncate text-[12px] leading-tight text-[#a1a1aa]">
                          Saved
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[12px]">
                      {isBusy ? (
                        <LoaderCircle
                          size={15}
                          strokeWidth={2}
                          className="animate-spin text-[#a1a1aa]"
                          aria-hidden="true"
                        />
                      ) : isActive ? (
                        canManage ? (
                          <>
                            <span
                              className="group-hover:hidden group-focus-within:hidden"
                              style={{ color: color.accent }}
                            >
                              Live
                            </span>
                            <span className="hidden text-[#a1a1aa] group-hover:inline group-focus-within:inline">
                              Close
                            </span>
                          </>
                        ) : (
                          <span style={{ color: color.accent }}>Live</span>
                        )
                      ) : canManage ? (
                        <>
                          {!canClear && (
                            <span className="text-[#71717a] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                              Present
                            </span>
                          )}
                          <ChevronRight
                            size={16}
                            strokeWidth={1.6}
                            className="text-[#71717a]"
                            aria-hidden="true"
                          />
                        </>
                      ) : null}
                    </span>
                  </button>
                  {canClear && (
                    <button
                      type="button"
                      disabled={!interactive}
                      onClick={() => handleClear(app.id)}
                      onBlur={() => {
                        if (confirming) setConfirmingClear(null);
                      }}
                      aria-label={
                        confirming
                          ? `Clear ${app.name} for everyone`
                          : `Clear ${app.name}`
                      }
                      className="mr-1.5 h-8 shrink-0 rounded-md px-2.5 text-[12px] transition-colors hover:bg-white/[0.06] disabled:cursor-default"
                      style={{
                        color: confirming ? color.danger : "#a1a1aa",
                      }}
                    >
                      {confirming ? "Confirm clear" : "Clear"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {canManage && (
            <label
              className="mt-2 flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 text-[13px] text-[#a1a1aa] transition-colors hover:bg-white/[0.04] hover:text-[#fafafa]"
              title="Participants can watch the open app but not edit it"
            >
              <span className="min-w-0 truncate">Lock app editing</span>
              <input
                type="checkbox"
                checked={state.locked}
                onChange={(event) => void setLocked(event.target.checked)}
                className="h-4 w-4 shrink-0 cursor-pointer accent-[#f95f4a]"
              />
            </label>
          )}

          {error && (
            <p role="alert" className="mt-2 px-2.5 text-[12px]" style={{ color: color.danger }}>
              {error}
            </p>
          )}
        </section>

        <a
          href={APPS_SDK_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-[#71717a] transition-colors hover:text-[#fafafa]"
        >
          Build your own app
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}

const SECTION_LABEL_CLASS =
  "mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#71717a]";

const ROW_CLASS =
  "relative flex min-h-12 w-full items-center overflow-hidden rounded-lg border transition-colors";

const APP_ICON_TONE = {
  idle: "#d4d4d8",
  active: color.accent,
  muted: "#71717a",
} as const;

function AppIcon({
  tone,
  children,
}: {
  tone: keyof typeof APP_ICON_TONE;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.05] [&>svg]:h-[17px] [&>svg]:w-[17px]"
      style={{ color: APP_ICON_TONE[tone] }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
