"use client";

import { Loader2, WifiOff } from "lucide-react";
import type { ConnectionState } from "../lib/types";

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
  if (
    !isOffline &&
    !showServerRestartNotice &&
    !["reconnecting", "disconnected", "error"].includes(state)
  ) {
    return null;
  }

  const isReconnecting = state === "reconnecting" || showServerRestartNotice;
  const isTerminal = !isOffline && !isReconnecting;
  const message = isOffline
    ? "You’re offline. Check your internet connection."
    : showServerRestartNotice
      ? serverRestartNotice
      : isReconnecting
        ? "Reconnecting…"
        : "Connection lost.";

  // accent for in-progress recovery, danger for hard failures.
  const tone = isReconnecting
    ? { dot: "#F95F4A", text: "text-[#fafafa]" }
    : { dot: "#ea4335", text: "text-[#fafafa]" };

  const handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <div
      className={`absolute left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5 rounded-full border border-[#fafafa]/10 bg-[#18181b]/95 backdrop-blur-md px-3.5 py-2 ${
        compact ? "top-3" : "top-4"
      }`}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
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
  );
}
