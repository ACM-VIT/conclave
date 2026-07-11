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

const APPS_SDK_DOCS_URL =
  "https://github.com/ACM-VIT/conclave/blob/main/packages/apps-sdk/docs/guides/add-a-new-app-integration.md";

/**
 * The docked Apps launcher. Every app registered with the Apps SDK shows up
 * here automatically; the host opens one for the whole room, everyone else
 * sees what is live.
 */
export function AppsPanel({
  onClose,
  rightOffset = 0,
  dockWidth,
  maxDockWidth,
  onDockWidthChange,
}: {
  onClose: () => void;
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-2">
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
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]"
                        style={{
                          color: color.accent,
                          background: "rgba(249,95,74,0.12)",
                        }}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: color.accent }}
                        />
                        Live
                      </span>
                      {canManage && (
                        <span className="text-[11.5px] text-[#71717a] opacity-0 transition-opacity group-hover:opacity-100">
                          Close
                        </span>
                      )}
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
