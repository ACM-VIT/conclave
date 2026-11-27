"use client";

import { useEffect } from "react";
import type { ConnectionState, JoinMode } from "../lib/types";

interface UseMeetingAddressOptions {
  enabled: boolean;
  joinMode: JoinMode;
  connectionState: ConnectionState;
  roomId: string;
}

// Once a join lands, in the call or knocking, the address bar shows the
// meeting, so a reload or a copied URL leads back to its pre-join screen.
export function useMeetingAddress({
  enabled,
  joinMode,
  connectionState,
  roomId,
}: UseMeetingAddressOptions) {
  useEffect(() => {
    if (!enabled || joinMode !== "meeting") return;
    if (connectionState !== "joined" && connectionState !== "waiting") return;
    const code = roomId.trim();
    if (!code || typeof window === "undefined") return;
    const path = `/${encodeURIComponent(code)}`;
    if (window.location.pathname === path) return;
    window.history.pushState(null, "", path);
  }, [connectionState, enabled, joinMode, roomId]);
}
