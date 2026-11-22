"use client";

import React, { useState } from "react";
import { Blocks, ExternalLink, LoaderCircle } from "lucide-react";
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-2">
          <p className="mb-1 text-[13px] leading-relaxed text-[#a1a1aa]">
            {isReadOnly
              ? "Observer mode can use apps but not present them."
              : canManage
                ? "Present an app to everyone in the room."
                : "The host presents apps here for everyone."}
          </p>

          {apps.map((app) => {
            const isActive = state.activeAppId === app.id;
            const isSaved = state.savedAppIds.includes(app.id);
            const isBusy = busyAppId === app.id;
            const interactive = canManage && !busyAppId;
            const confirming = isConfirmingClear(app.id);
            const canClear = canManage && isSaved && !isBusy;
            const subtitle = isSaved ? "Saved" : app.description;
            return (
              <div
                key={app.id}
                className="group relative flex w-full items-center overflow-hidden rounded-xl border transition-colors"
                style={{
                  borderColor: isActive ? color.accent : "rgba(255,255,255,0.1)",
                  background: color.surfaceRaised,
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
                  className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left disabled:cursor-default"
                  style={{ cursor: interactive ? "pointer" : "default" }}
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
                    {subtitle && (
                      <span className="truncate text-[12px] text-[#a1a1aa]">
                        {subtitle}
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
                        <span className="sr-only">Presenting now</span>
                      </>
                    ) : canManage ? (
                      <>
                        {!canClear && (
                          <span className="text-[11.5px] text-[#71717a] opacity-0 transition-opacity group-hover:opacity-100">
                            Present
                          </span>
                        )}
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
                    className="mr-2 shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-white/[0.06] disabled:cursor-default"
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
