"use client";

import React, { useState } from "react";
import { Blocks, ExternalLink, LoaderCircle } from "lucide-react";
import { useApps } from "@conclave/apps-sdk";
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
  description?: string;
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

/** "Polls and Q&A need a server update.", for the apps named. */
const needsServerUpdateNote = (names: string[]): string =>
  `${names.join(" and ")} ${names.length > 1 ? "need" : "needs"} a server update.`;

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
  const { apps, state, openApp, closeApp, setLocked, isAdmin, isReadOnly } =
    useApps();
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = Boolean(isAdmin) && !isReadOnly;
  const noneAvailable =
    panelApps.length > 0 && panelApps.every((app) => app.needsServerUpdate);

  const run = async (appId: string, action: () => Promise<boolean>) => {
    setBusyAppId(appId);
    setError(null);
    const ok = await action();
    setBusyAppId(null);
    if (!ok) setError("That did not go through. Try again.");
    return ok;
  };

  const handlePick = (appId: string) => {
    if (!canManage || busyAppId) return;
    const isActive = state.activeAppId === appId;
    void run(appId, () => (isActive ? closeApp() : openApp(appId)));
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-2">
          {panelApps.length > 0 && (
            <>
              <p
                className="mb-1 text-[13px] leading-relaxed text-[#a1a1aa]"
                data-testid={noneAvailable ? "panel-apps-unavailable" : undefined}
              >
                {noneAvailable
                  ? needsServerUpdateNote(panelApps.map((app) => app.name))
                  : "Open beside the call. Only you see the panel."}
              </p>
              {panelApps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  data-testid={`panel-app-${app.id}`}
                  disabled={app.needsServerUpdate}
                  title={app.needsServerUpdate ? NEEDS_SERVER_UPDATE : undefined}
                  onClick={app.onToggle}
                  aria-pressed={app.needsServerUpdate ? undefined : app.isOpen}
                  aria-label={
                    app.needsServerUpdate
                      ? `${app.name}: ${NEEDS_SERVER_UPDATE.toLowerCase()}`
                      : app.isOpen
                        ? `Close ${app.name}`
                        : `Open ${app.name}`
                  }
                  className="group relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-colors disabled:cursor-default"
                  style={{
                    borderColor: app.isOpen ? color.accent : "rgba(255,255,255,0.1)",
                    background: app.needsServerUpdate
                      ? "transparent"
                      : color.surfaceRaised,
                  }}
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
                    style={{
                      borderColor: "rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.04)",
                      color: app.needsServerUpdate
                        ? "#71717a"
                        : app.isOpen
                          ? color.accent
                          : "#d4d4d8",
                    }}
                    aria-hidden="true"
                  >
                    {app.icon}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="text-[14.5px] font-medium"
                      style={{ color: app.needsServerUpdate ? "#a1a1aa" : "#fafafa" }}
                    >
                      {app.name}
                    </span>
                    {app.needsServerUpdate ? (
                      <span className="truncate text-[12px] text-[#a1a1aa]">
                        {NEEDS_SERVER_UPDATE}
                      </span>
                    ) : (
                      app.description && (
                        <span className="truncate text-[12px] text-[#a1a1aa]">
                          {app.description}
                        </span>
                      )
                    )}
                  </span>
                  {app.needsAttention && !app.isOpen && (
                    <span className="flex shrink-0 items-center">
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: color.accent }}
                      />
                      <span className="sr-only">Waiting for you</span>
                    </span>
                  )}
                </button>
              ))}
              <div className="my-2 h-px bg-white/10" aria-hidden="true" />
            </>
          )}
          <p className="mb-1 text-[13px] leading-relaxed text-[#a1a1aa]">
            {isReadOnly
              ? "Observer mode can use apps but not open them."
              : canManage
                ? "Open a shared app for everyone in the room."
                : "The host opens apps; they appear here for everyone."}
          </p>

          {apps.map((app) => {
            const isActive = state.activeAppId === app.id;
            const isBusy = busyAppId === app.id;
            const interactive = canManage && !busyAppId;
            return (
              <button
                key={app.id}
                type="button"
                disabled={!interactive}
                onClick={() => handlePick(app.id)}
                aria-label={
                  isActive ? `Close ${app.name}` : `Open ${app.name}`
                }
                className="group relative flex w-full items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-colors disabled:cursor-default"
                style={{
                  borderColor: isActive ? color.accent : "rgba(255,255,255,0.1)",
                  background: color.surfaceRaised,
                  cursor: interactive ? "pointer" : "default",
                }}
              >
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
                  style={{
                    borderColor: "rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.04)",
                    color: isActive ? color.accent : "#d4d4d8",
                  }}
                  aria-hidden="true"
                >
                  {app.icon ?? <Blocks size={19} strokeWidth={1.75} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14.5px] font-medium text-[#fafafa]">
                    {app.name}
                  </span>
                  {app.description && (
                    <span className="truncate text-[12px] text-[#a1a1aa]">
                      {app.description}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {isBusy ? (
                    <LoaderCircle
                      size={15}
                      strokeWidth={2}
                      className="animate-spin text-[#a1a1aa]"
                      aria-hidden="true"
                    />
                  ) : isActive ? (
                    <>
                      {canManage && (
                        <span className="text-[11.5px] text-[#71717a] opacity-0 transition-opacity group-hover:opacity-100">
                          Close
                        </span>
                      )}
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: color.accent }}
                      />
                      <span className="sr-only">Open now</span>
                    </>
                  ) : canManage ? (
                    <svg
                      width={16}
                      height={16}
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                      className="text-[#71717a]"
                    >
                      <path
                        d="M9 6l6 6-6 6"
                        stroke="currentColor"
                        strokeWidth={1.6}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
              </button>
            );
          })}

          {canManage && (
            <label
              className="mt-1 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5"
              title="Participants can watch the open app but not edit it"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-[#fafafa]">
                  Lock app editing
                </span>
                <span className="text-[12px] leading-snug text-[#a1a1aa]">
                  Participants watch only
                </span>
              </span>
              <input
                type="checkbox"
                checked={state.locked}
                onChange={(event) => void setLocked(event.target.checked)}
                className="h-4 w-4 shrink-0 cursor-pointer accent-[#f95f4a]"
              />
            </label>
          )}

          {error && (
            <p className="mt-1 text-[12px]" style={{ color: color.danger }}>
              {error}
            </p>
          )}

          <a
            href={APPS_SDK_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="group mt-2 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.045]"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-[#fafafa]">
                Build your own app
              </span>
              <span className="text-[12px] leading-snug text-[#a1a1aa]">
                Ship it with the Apps SDK
              </span>
            </span>
            <ExternalLink
              size={15}
              strokeWidth={1.75}
              className="shrink-0 text-[#71717a] transition-colors group-hover:text-[#fafafa]"
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
    </aside>
  );
}
