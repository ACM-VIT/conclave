"use client";

import { useCallback, useEffect } from "react";
import type { Socket } from "socket.io-client";

interface UseMeetHandRaiseOptions {
  isHandRaised: boolean;
  setIsHandRaised: (value: boolean) => void;
  isHandRaisedRef: React.MutableRefObject<boolean>;
  ghostEnabled: boolean;
  isObserverMode?: boolean;
  socketRef: React.MutableRefObject<Socket | null>;
}

export function useMeetHandRaise({
  isHandRaised,
  setIsHandRaised,
  isHandRaisedRef,
  ghostEnabled,
  isObserverMode = false,
  socketRef,
}: UseMeetHandRaiseOptions) {
  useEffect(() => {
    isHandRaisedRef.current = isHandRaised;
  }, [isHandRaised, isHandRaisedRef]);

  const setHandRaisedState = useCallback(
    (raised: boolean) => {
      if (ghostEnabled || isObserverMode) return;
      const socket = socketRef.current;
      setIsHandRaised(raised);

      if (!socket) return;

      socket.emit(
        "setHandRaised",
        { raised },
        (response: { success: boolean } | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Raise hand error:", response.error);
            setIsHandRaised(!raised);
          }
        }
      );
    },
    [ghostEnabled, isObserverMode, socketRef, setIsHandRaised]
  );

  const toggleHandRaised = useCallback(() => {
    setHandRaisedState(!isHandRaisedRef.current);
  }, [setHandRaisedState, isHandRaisedRef]);

  return {
    setHandRaisedState,
    toggleHandRaised,
  };
}
