"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import { SOCKET_TIMEOUT_MS } from "../lib/constants";

interface UseMeetHandRaiseOptions {
  isHandRaised: boolean;
  setIsHandRaised: (value: boolean) => void;
  isHandRaisedRef: React.MutableRefObject<boolean>;
  isObserverMode?: boolean;
  socketRef: React.MutableRefObject<Socket | null>;
}

export function useMeetHandRaise({
  isHandRaised,
  setIsHandRaised,
  isHandRaisedRef,
  isObserverMode = false,
  socketRef,
}: UseMeetHandRaiseOptions) {
  useEffect(() => {
    isHandRaisedRef.current = isHandRaised;
  }, [isHandRaised, isHandRaisedRef]);

  // Each toggle is optimistic. Only the newest request may roll the state
  // back, so a late failure from an older toggle cannot undo a newer one.
  const requestSerialRef = useRef(0);

  const setHandRaisedState = useCallback(
    (raised: boolean) => {
      if (isObserverMode) return;
      const socket = socketRef.current;
      setIsHandRaised(raised);

      if (!socket) return;

      requestSerialRef.current += 1;
      const requestSerial = requestSerialRef.current;
      const rollBack = () => {
        if (requestSerialRef.current !== requestSerial) return;
        setIsHandRaised(!raised);
      };

      socket.timeout(SOCKET_TIMEOUT_MS).emit(
        "setHandRaised",
        { raised },
        (
          error: Error | null,
          response: { success: boolean } | { error: string } | undefined,
        ) => {
          if (error || !response) {
            console.error("[Meets] Raise hand got no acknowledgement", error);
            rollBack();
            return;
          }
          if ("error" in response) {
            console.error("[Meets] Raise hand error:", response.error);
            rollBack();
          }
        }
      );
    },
    [isObserverMode, socketRef, setIsHandRaised]
  );

  const toggleHandRaised = useCallback(() => {
    setHandRaisedState(!isHandRaisedRef.current);
  }, [setHandRaisedState, isHandRaisedRef]);

  return {
    setHandRaisedState,
    toggleHandRaised,
  };
}
