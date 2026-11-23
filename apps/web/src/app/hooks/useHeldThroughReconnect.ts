"use client";

import { useState } from "react";

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
