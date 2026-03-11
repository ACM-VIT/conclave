"use client";

import { useEffect, useRef } from "react";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";

interface UseMeetHandRaiseSoundOptions {
  participants: Map<string, Participant>;
  connectionState: "disconnected" | "connecting" | "connected" | "joining" | "joined" | "reconnecting" | "waiting" | "error";
  currentUserId: string;
  isHandRaised: boolean;
  playNotificationSound: (type: "join" | "leave" | "waiting" | "handRaise") => void;
}

export function useMeetHandRaiseSound({
  participants,
  connectionState,
  currentUserId,
  isHandRaised,
  playNotificationSound,
}: UseMeetHandRaiseSoundOptions) {
  const hasInitializedRef = useRef(false);
  const lastSoundAtRef = useRef(0);
  const previousRemoteRaisedMapRef = useRef<Map<string, boolean>>(new Map());
  const previousLocalRaisedRef = useRef(false);

  useEffect(() => {
    const remoteRaisedMap = new Map<string, boolean>();
    for (const participant of participants.values()) {
      if (
        participant.userId === currentUserId ||
        isSystemUserId(participant.userId)
      ) {
        continue;
      }

      remoteRaisedMap.set(participant.userId, Boolean(participant.isHandRaised));
    }

    if (connectionState !== "joined") {
      hasInitializedRef.current = false;
      previousRemoteRaisedMapRef.current = remoteRaisedMap;
      previousLocalRaisedRef.current = isHandRaised;
      return;
    }

    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      previousRemoteRaisedMapRef.current = remoteRaisedMap;
      previousLocalRaisedRef.current = isHandRaised;
      return;
    }

    const remoteJustRaised = Array.from(remoteRaisedMap.entries()).some(
      ([userId, raised]) => {
        const wasRaised = previousRemoteRaisedMapRef.current.get(userId) ?? false;
        return raised && !wasRaised;
      }
    );
    const localJustRaised = !previousLocalRaisedRef.current && isHandRaised;

    if (remoteJustRaised || localJustRaised) {
      const now = Date.now();
      if (now - lastSoundAtRef.current >= 500) {
        playNotificationSound("handRaise");
        lastSoundAtRef.current = now;
      }
    }

    previousRemoteRaisedMapRef.current = remoteRaisedMap;
    previousLocalRaisedRef.current = isHandRaised;
  }, [
    participants,
    connectionState,
    currentUserId,
    isHandRaised,
    playNotificationSound,
  ]);
}
