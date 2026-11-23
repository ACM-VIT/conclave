"use client";

import { useMemo, useState } from "react";
import { useAuthorityRuntime } from "@conclave/apps-sdk";
import { reconnectHold, type ReconnectHold } from "../lib/meeting-surface-policy";
import type { ConnectionState } from "../lib/types";

export type { ReconnectHold };

export function useReconnectHold({
  isJoined,
  connectionState,
}: {
  isJoined: boolean;
  connectionState: ConnectionState;
}): ReconnectHold {
  const authorityRuntime = useAuthorityRuntime();
  const { connectionLive, holdingThroughReconnect } = reconnectHold({
    isJoined,
    connectionState,
    authorityRuntime,
  });
  return useMemo(
    () => ({ connectionLive, holdingThroughReconnect }),
    [connectionLive, holdingThroughReconnect],
  );
}

export const WAITING_FOR_VIEW = {
  ok: false as const,
  error: "Reconnecting. Try again in a moment.",
};

export const waitForView = async (): Promise<typeof WAITING_FOR_VIEW> => WAITING_FOR_VIEW;

export function useHeldThroughReconnect<T>(live: T, holding: boolean): T {
  const [held, setHeld] = useState(() => live);
  if (!holding && held !== live) setHeld(() => live);
  return holding ? held : live;
}
