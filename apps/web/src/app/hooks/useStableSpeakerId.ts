"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface UseStableSpeakerIdOptions {
  primarySpeakerId: string | null | undefined;
  secondarySpeakerId?: string | null;
  participantIds: readonly string[];
  promoteDelayMs?: number;
  minSwitchIntervalMs?: number;
}

export function useStableSpeakerId({
  primarySpeakerId,
  secondarySpeakerId = null,
  participantIds,
  promoteDelayMs = 450,
  minSwitchIntervalMs = 1800,
}: UseStableSpeakerIdOptions): string | null {
  const [stableSpeakerId, setStableSpeakerId] = useState<string | null>(null);
  const stableSpeakerIdRef = useRef<string | null>(null);
  const candidateSpeakerIdRef = useRef<string | null>(null);
  const candidateSinceMsRef = useRef(0);
  const lastSwitchAtMsRef = useRef(0);
  const promoteTimeoutRef = useRef<number | null>(null);
  const participantIdsKey = useMemo(() => participantIds.join("|"), [participantIds]);
  const participantIdSet = useMemo(
    () => new Set(participantIds),
    [participantIdsKey],
  );

  const visibleCandidateId = useMemo(() => {
    if (primarySpeakerId && participantIdSet.has(primarySpeakerId)) {
      return primarySpeakerId;
    }
    if (
      secondarySpeakerId &&
      secondarySpeakerId !== primarySpeakerId &&
      participantIdSet.has(secondarySpeakerId)
    ) {
      return secondarySpeakerId;
    }
    return null;
  }, [participantIdSet, primarySpeakerId, secondarySpeakerId]);

  useEffect(() => {
    stableSpeakerIdRef.current = stableSpeakerId;
  }, [stableSpeakerId]);

  useEffect(() => {
    return () => {
      if (promoteTimeoutRef.current !== null) {
        window.clearTimeout(promoteTimeoutRef.current);
        promoteTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const clearPromoteTimeout = () => {
      if (promoteTimeoutRef.current !== null) {
        window.clearTimeout(promoteTimeoutRef.current);
        promoteTimeoutRef.current = null;
      }
    };

    if (
      stableSpeakerIdRef.current &&
      !participantIdSet.has(stableSpeakerIdRef.current)
    ) {
      stableSpeakerIdRef.current = null;
      setStableSpeakerId(null);
    }

    clearPromoteTimeout();

    if (!visibleCandidateId) {
      candidateSpeakerIdRef.current = null;
      candidateSinceMsRef.current = 0;
      return;
    }

    if (visibleCandidateId === stableSpeakerIdRef.current) {
      candidateSpeakerIdRef.current = null;
      candidateSinceMsRef.current = 0;
      return;
    }

    if (!stableSpeakerIdRef.current) {
      stableSpeakerIdRef.current = visibleCandidateId;
      lastSwitchAtMsRef.current = Date.now();
      candidateSpeakerIdRef.current = null;
      candidateSinceMsRef.current = 0;
      setStableSpeakerId((previous) =>
        previous === visibleCandidateId ? previous : visibleCandidateId,
      );
      return;
    }

    const now = Date.now();
    if (candidateSpeakerIdRef.current !== visibleCandidateId) {
      candidateSpeakerIdRef.current = visibleCandidateId;
      candidateSinceMsRef.current = now;
    }

    const attemptPromotion = () => {
      const candidateSpeakerId = candidateSpeakerIdRef.current;
      if (!candidateSpeakerId) return;
      if (!participantIdSet.has(candidateSpeakerId)) return;
      if (stableSpeakerIdRef.current === candidateSpeakerId) return;

      const nowMs = Date.now();
      const elapsedSinceSwitch = nowMs - lastSwitchAtMsRef.current;
      if (elapsedSinceSwitch < minSwitchIntervalMs) {
        promoteTimeoutRef.current = window.setTimeout(
          attemptPromotion,
          minSwitchIntervalMs - elapsedSinceSwitch,
        );
        return;
      }

      stableSpeakerIdRef.current = candidateSpeakerId;
      lastSwitchAtMsRef.current = nowMs;
      candidateSpeakerIdRef.current = null;
      candidateSinceMsRef.current = 0;
      setStableSpeakerId((previous) =>
        previous === candidateSpeakerId ? previous : candidateSpeakerId,
      );
    };

    const elapsedForCandidateMs = now - candidateSinceMsRef.current;
    const waitMs = Math.max(0, promoteDelayMs - elapsedForCandidateMs);
    promoteTimeoutRef.current = window.setTimeout(attemptPromotion, waitMs);

    return () => {
      clearPromoteTimeout();
    };
  }, [
    minSwitchIntervalMs,
    participantIdSet,
    participantIdsKey,
    promoteDelayMs,
    visibleCandidateId,
  ]);

  return stableSpeakerId;
}
