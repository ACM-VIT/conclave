"use client";

import { RefreshCw, WifiOff } from "lucide-react";
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
  const message = isOffline
    ? "You’re offline. Reconnect your internet to restore call audio/video."
    : showServerRestartNotice
      ? serverRestartNotice
    : isReconnecting
      ? "Reconnecting… we’ll keep trying."
      : "Connection lost. Refresh to rejoin.";

  const handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <div
      className={`absolute left-1/2 -translate-x-1/2 z-40 rounded-full border border-[#FEFCD9]/10 bg-black/70 backdrop-blur-md px-4 py-2 ${
        compact ? "top-3" : "top-4"
      }`}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex items-center gap-3 text-[#FEFCD9]/80">
        {isOffline || !isReconnecting ? (
          <WifiOff className="w-3.5 h-3.5 text-[#F95F4A]" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#F95F4A]" />
        )}
        <span className={`${compact ? "text-[11px]" : "text-xs"}`}>
          {message}
        </span>
        {!isOffline && !isReconnecting && !showServerRestartNotice && (
          <button
            onClick={handleReload}
            className="ml-1 text-[10px] uppercase tracking-widest text-[#F95F4A] hover:text-[#f97b6a] transition-colors"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Refresh
          </button>
        )}
      </div>
    </div>
  );
}
