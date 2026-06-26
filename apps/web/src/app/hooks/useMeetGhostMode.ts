"use client";

import { useEffect } from "react";

interface UseMeetGhostModeOptions {
  canGhostJoin: boolean;
  isGhostMode: boolean;
  setIsGhostMode: (value: boolean) => void;
  ghostEnabled: boolean;
  setIsMuted: (value: boolean) => void;
  setIsCameraOff: (value: boolean) => void;
  setIsScreenSharing: (value: boolean) => void;
  setIsHandRaised: (value: boolean) => void;
}

export function useMeetGhostMode({
  canGhostJoin,
  isGhostMode,
  setIsGhostMode,
  ghostEnabled,
  setIsMuted,
  setIsCameraOff,
  setIsScreenSharing,
  setIsHandRaised,
}: UseMeetGhostModeOptions) {
  useEffect(() => {
    if (!canGhostJoin && isGhostMode) {
      setIsGhostMode(false);
    }
  }, [canGhostJoin, isGhostMode, setIsGhostMode]);

  useEffect(() => {
    if (!ghostEnabled) return;
    setIsMuted(true);
    setIsCameraOff(true);
    setIsScreenSharing(false);
    setIsHandRaised(false);
  }, [
    ghostEnabled,
    setIsMuted,
    setIsCameraOff,
    setIsScreenSharing,
    setIsHandRaised,
  ]);
}
