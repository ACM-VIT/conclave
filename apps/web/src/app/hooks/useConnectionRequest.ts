"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Pending = { key: string; connection: unknown };

export function useConnectionRequest(connection: unknown) {
  const [pending, setPending] = useState<Pending | null>(null);
  const connectionRef = useRef(connection);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const run = useCallback(
    async <R,>(key: string | null, task: () => Promise<R>): Promise<R | null> => {
      const sentOn = connectionRef.current;
      const mine: Pending | null = key === null ? null : { key, connection: sentOn };
      if (mine) setPending(mine);
      try {
        const result = await task();
        return connectionRef.current === sentOn ? result : null;
      } finally {
        if (mine) setPending((current) => (current === mine ? null : current));
      }
    },
    [],
  );

  return { busy: pending !== null && pending.connection === connection ? pending.key : null, run };
}
