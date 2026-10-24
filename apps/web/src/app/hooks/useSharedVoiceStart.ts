"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomAiController } from "./useRoomAi";

export function useSharedVoiceStart(
  controller: RoomAiController,
  scope: string,
  onReady: (key: string, remember: boolean) => void,
) {
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(() => {
    generation.current++;
    setPending(false);
    setError(null);
  }, []);
  useEffect(() => {
    cancel();
    return () => {
      generation.current++;
    };
  }, [scope, cancel]);
  const start = useCallback(
    async (key: string, remember: boolean) => {
      const attempt = ++generation.current;
      setPending(true);
      setError(null);
      let failure: string | null;
      try {
        failure = await controller.configure("openai", key, null);
      } catch {
        failure = "Could not share the room key. Try again.";
      }
      if (attempt !== generation.current) return;
      setPending(false);
      if (failure) {
        setError(failure);
        return;
      }
      onReady(key, remember);
    },
    [controller, onReady],
  );
  return { start, cancel, pending, error };
}
