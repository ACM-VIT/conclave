"use client";

import { Loader2, RefreshCw, WifiOff } from "lucide-react";
import type { ConnectionState } from "../lib/types";
import InCallNotice from "./InCallNotice";
import InCallNoticeCard from "./InCallNoticeCard";

interface ConnectionBannerProps {
  state: ConnectionState;
  isOffline?: boolean;
  serverRestartNotice?: string | null;
}

export default function ConnectionBanner({
  state,
  isOffline = false,
  serverRestartNotice = null,
}: ConnectionBannerProps) {
  const hasTerminalConnectionState =
    state === "disconnected" || state === "error";
  const showServerRestartNotice =
    Boolean(serverRestartNotice) && !hasTerminalConnectionState && !isOffline;
  const show =
    isOffline ||
    showServerRestartNotice ||
    ["reconnecting", "disconnected", "error"].includes(state);
  const isReconnecting = state === "reconnecting" || showServerRestartNotice;

  return (
    <InCallNotice show={show}>
      {isOffline ? (
        <InCallNoticeCard
          tone="warning"
          icon={WifiOff}
          title="You’re offline"
          detail="Check your internet connection."
        />
      ) : isReconnecting ? (
        <InCallNoticeCard
          tone="warning"
          icon={Loader2}
          spinIcon
          title={
            showServerRestartNotice && serverRestartNotice
              ? serverRestartNotice
              : "Trying to reconnect"
          }
        />
      ) : (
        <InCallNoticeCard
          tone="error"
          icon={RefreshCw}
          title="Lost connection to the call"
          actionLabel="Refresh"
          onAction={() => window.location.reload()}
        />
      )}
    </InCallNotice>
  );
}
