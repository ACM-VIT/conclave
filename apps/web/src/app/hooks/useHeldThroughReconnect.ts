"use client";

import { useState } from "react";

export function useHeldThroughReconnect<T>(live: T, holding: boolean): T {
  const [held, setHeld] = useState(() => live);
  if (!holding && held !== live) setHeld(() => live);
  return holding ? held : live;
}
