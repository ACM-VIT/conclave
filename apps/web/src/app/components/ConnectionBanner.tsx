"use client";

import { Loader2, WifiOff } from "lucide-react";
import type { ConnectionState } from "../lib/types";
import { InCallNotice } from "./InCallNotices";

interface ConnectionBannerProps {
  state: ConnectionState;
  compact?: boolean;
  isOffline?: boolean;
  serverRestartNotice?: string | null;
}

export default function ConnectionBanner({
  state,
  compact = false,
  isOffline = false,
  serverRestartNotice = null,
}: ConnectionBannerProps) {
  const hasServerRestartNotice = Boolean(serverRestartNotice);
  const hasTerminalConnectionState =
    state === "disconnected" || state === "error";
  const showServerRestartNotice =
    hasServerRestartNotice && !hasTerminalConnectionState && !isOffline;
  const show =
    isOffline ||
    showServerRestartNotice ||
    ["reconnecting", "disconnected", "error"].includes(state);

  const isReconnecting = state === "reconnecting" || showServerRestartNotice;
  const isTerminal = !isOffline && !isReconnecting;
  const message = isOffline
    ? "You’re offline. Check your internet connection."
    : showServerRestartNotice
      ? serverRestartNotice
      : isReconnecting
        ? "Connection interrupted. Reconnecting to the meeting…"
        : "Meeting connection lost.";

  const tone = isReconnecting
    ? { dot: "#F95F4A", text: "text-[#fafafa]" }
    : { dot: "#ea4335", text: "text-[#fafafa]" };

  const handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <InCallNotice show={show}>
      <div
        className="flex max-w-full items-center gap-2.5 rounded-full border border-[#fafafa]/10 bg-[#18181b] px-3.5 py-2"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        role="status"
        aria-live="polite"
      >
        {isReconnecting ? (
          <Loader2
            size={18}
            strokeWidth={1.75}
            className="animate-spin shrink-0"
            style={{ color: tone.dot }}
          />
        ) : isOffline ? (
          <WifiOff
            size={18}
            strokeWidth={1.75}
            className="shrink-0"
            style={{ color: tone.dot }}
          />
        ) : (
          <span
            className="block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: tone.dot }}
          />
        )}
        <span
          className={`${compact ? "text-[12.5px]" : "text-[13px]"} leading-snug ${tone.text}`}
        >
          {message}
        </span>
        {isTerminal && (
          <button
            onClick={handleReload}
            className="ml-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-[#F95F4A] transition-colors hover:bg-[#fafafa]/[0.06]"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            Refresh
          </button>
        )}
      </div>
    </InCallNotice>
  );
}
