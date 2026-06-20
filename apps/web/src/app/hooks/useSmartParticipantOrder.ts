"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface ParticipantWithMediaHints {
  userId: string;
  videoStream?: MediaStream | null;
  audioStream?: MediaStream | null;
  isCameraOff?: boolean;
  isVideoAdaptivelyPaused?: boolean;
  isMuted?: boolean;
  isHandRaised?: boolean;
}

interface UseSmartParticipantOrderOptions {
  promoteDelayMs?: number;
  minSwitchIntervalMs?: number;
  minParticipantsForReorder?: number;
}

interface SmartParticipantOrderResult<T extends ParticipantWithMediaHints> {
  orderedParticipants: T[];
  featuredSpeakerId: string | null;
}

const hasLiveTrack = (
  stream: MediaStream | null | undefined,
  kind: "audio" | "video"
): boolean => {
  if (!stream) return false;
  const track =
    kind === "video" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
  return Boolean(track && track.readyState === "live");
};

const getMediaPriority = (participant: ParticipantWithMediaHints): number => {
  const hasVideo =
    !participant.isCameraOff &&
    hasLiveTrack(participant.videoStream, "video");
  if (hasVideo) return 2;
  const hasAudio =
    !participant.isMuted && hasLiveTrack(participant.audioStream, "audio");
  if (hasAudio) return 1;
  return 0;
};

const DEFAULT_MIN_PARTICIPANTS_FOR_REORDER = 4;

export function useSmartParticipantOrderWithMetadata<
  T extends ParticipantWithMediaHints,
>(
  participants: readonly T[],
  activeSpeakerId: string | null,
  options: UseSmartParticipantOrderOptions = {}
): SmartParticipantOrderResult<T> {
  const {
    promoteDelayMs = 700,
    minSwitchIntervalMs = 2200,
    minParticipantsForReorder = DEFAULT_MIN_PARTICIPANTS_FOR_REORDER,
  } = options;
  const canReorderParticipants = participants.length >= minParticipantsForReorder;
  const participantIdsKey = useMemo(
    () => participants.map((participant) => participant.userId).join("|"),
    [participants]
  );
  const [featuredSpeakerId, setFeaturedSpeakerId] = useState<string | null>(null);
  const [raisedOrder, setRaisedOrder] = useState<string[]>([]);
  const participantsRef = useRef(participants);
  const featuredSpeakerIdRef = useRef<string | null>(null);
  const candidateIdRef = useRef<string | null>(null);
  const candidateSinceRef = useRef(0);
  const lastSwitchAtRef = useRef(0);
  const promoteTimeoutRef = useRef<number | null>(null);
  const previousOrderRef = useRef<Map<string, number>>(new Map());
  const previousRaisedMapRef = useRef<Map<string, boolean>>(new Map());
  const previousResultRef = useRef<T[]>([]);

  const clearPromoteTimeout = () => {
    if (promoteTimeoutRef.current) {
      window.clearTimeout(promoteTimeoutRef.current);
      promoteTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    featuredSpeakerIdRef.current = featuredSpeakerId;
  }, [featuredSpeakerId]);

  useEffect(() => {
    return () => {
      clearPromoteTimeout();
    };
  }, []);

  useEffect(() => {
    if (
      featuredSpeakerIdRef.current &&
      !participantsRef.current.some(
        (participant) => participant.userId === featuredSpeakerIdRef.current
      )
    ) {
      featuredSpeakerIdRef.current = null;
      setFeaturedSpeakerId(null);
    }
  }, [participantIdsKey]);

  useEffect(() => {
    setRaisedOrder((previousOrder) => {
      const currentIds = new Set(participants.map((participant) => participant.userId));
      let nextOrder = previousOrder.filter((userId) => currentIds.has(userId));
      const nextRaisedMap = new Map<string, boolean>();

      for (const participant of participants) {
        const userId = participant.userId;
        const isRaised = Boolean(participant.isHandRaised);
        const wasRaised = previousRaisedMapRef.current.get(userId) ?? false;
        nextRaisedMap.set(userId, isRaised);

        if (isRaised) {
          if (!wasRaised && !nextOrder.includes(userId)) {
            nextOrder = [...nextOrder, userId];
          }
          continue;
        }

        if (nextOrder.includes(userId)) {
          nextOrder = nextOrder.filter((raisedUserId) => raisedUserId !== userId);
        }
      }

      previousRaisedMapRef.current = nextRaisedMap;

      const isUnchanged =
        previousOrder.length === nextOrder.length &&
        previousOrder.every((userId, index) => userId === nextOrder[index]);
      return isUnchanged ? previousOrder : nextOrder;
    });
  }, [participants]);

  useEffect(() => {
    clearPromoteTimeout();

    if (!canReorderParticipants) {
      candidateIdRef.current = null;
      candidateSinceRef.current = 0;
      if (featuredSpeakerIdRef.current) {
        featuredSpeakerIdRef.current = null;
        setFeaturedSpeakerId(null);
      }
      return;
    }

    const isActiveVisible =
      !!activeSpeakerId &&
      participantsRef.current.some(
        (participant) => participant.userId === activeSpeakerId
      );
    if (!isActiveVisible) {
      candidateIdRef.current = null;
      candidateSinceRef.current = 0;
      return;
    }

    const now = Date.now();
    if (candidateIdRef.current !== activeSpeakerId) {
      candidateIdRef.current = activeSpeakerId;
      candidateSinceRef.current = now;
    }

    const attemptPromotion = () => {
      const candidateId = candidateIdRef.current;
      if (!candidateId) return;
      if (!participantsRef.current.some((participant) => participant.userId === candidateId)) {
        return;
      }
      if (featuredSpeakerIdRef.current === candidateId) return;

      const nowMs = Date.now();
      const elapsedSinceSwitch = nowMs - lastSwitchAtRef.current;
      if (elapsedSinceSwitch < minSwitchIntervalMs) {
        promoteTimeoutRef.current = window.setTimeout(
          attemptPromotion,
          minSwitchIntervalMs - elapsedSinceSwitch
        );
        return;
      }

      featuredSpeakerIdRef.current = candidateId;
      lastSwitchAtRef.current = nowMs;
      setFeaturedSpeakerId((prev) => (prev === candidateId ? prev : candidateId));
    };

    const elapsedForCandidate = now - candidateSinceRef.current;
    const waitMs = Math.max(0, promoteDelayMs - elapsedForCandidate);
    promoteTimeoutRef.current = window.setTimeout(attemptPromotion, waitMs);

    return () => {
      clearPromoteTimeout();
    };
  }, [
    activeSpeakerId,
    canReorderParticipants,
    participantIdsKey,
    promoteDelayMs,
    minSwitchIntervalMs,
  ]);

  const orderedParticipants = useMemo(() => {
    if (!canReorderParticipants) {
      return [...participants];
    }

    const inputOrder = new Map(
      participants.map((participant, index) => [participant.userId, index] as const)
    );
    const previousOrder = previousOrderRef.current;
    const raisedOrderIndex = new Map(
      raisedOrder.map((userId, index) => [userId, index] as const)
    );

    return [...participants].sort((left, right) => {
      const leftIsFeatured = left.userId === featuredSpeakerId ? 1 : 0;
      const rightIsFeatured = right.userId === featuredSpeakerId ? 1 : 0;
      if (leftIsFeatured !== rightIsFeatured) {
        return rightIsFeatured - leftIsFeatured;
      }

      const leftRaised = Boolean(left.isHandRaised);
      const rightRaised = Boolean(right.isHandRaised);
      if (leftRaised !== rightRaised) {
        return leftRaised ? -1 : 1;
      }

      if (leftRaised && rightRaised) {
        const leftRaisedIndex =
          raisedOrderIndex.get(left.userId) ?? Number.MAX_SAFE_INTEGER;
        const rightRaisedIndex =
          raisedOrderIndex.get(right.userId) ?? Number.MAX_SAFE_INTEGER;
        if (leftRaisedIndex !== rightRaisedIndex) {
          return leftRaisedIndex - rightRaisedIndex;
        }
      }

      const leftPriority = getMediaPriority(left);
      const rightPriority = getMediaPriority(right);
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority;
      }

      const previousLeft = previousOrder.get(left.userId);
      const previousRight = previousOrder.get(right.userId);
      if (
        previousLeft !== undefined &&
        previousRight !== undefined &&
        previousLeft !== previousRight
      ) {
        return previousLeft - previousRight;
      }

      const leftIndex = inputOrder.get(left.userId) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = inputOrder.get(right.userId) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return left.userId.localeCompare(right.userId);
    });
  }, [canReorderParticipants, participants, featuredSpeakerId, raisedOrder]);

  // Return the SAME array reference when the resulting order is element-
  // identical (e.g. a participant's mute toggled but the sort didn't move
  // anyone). Protects every downstream useMemo/FLIP from re-running on a no-op
  // reorder — same trick `raisedOrder` already uses above.
  const stableOrdered = useMemo(() => {
    const prev = previousResultRef.current;
    const same =
      prev.length === orderedParticipants.length &&
      orderedParticipants.every((participant, index) => participant === prev[index]);
    const next = same ? prev : orderedParticipants;
    previousResultRef.current = next;
    return next;
  }, [orderedParticipants]);

  useEffect(() => {
    previousOrderRef.current = new Map(
      stableOrdered.map((participant, index) => [participant.userId, index] as const)
    );
  }, [stableOrdered]);

  return useMemo(
    () => ({
      orderedParticipants: stableOrdered,
      featuredSpeakerId: canReorderParticipants ? featuredSpeakerId : null,
    }),
    [canReorderParticipants, featuredSpeakerId, stableOrdered],
  );
}

export function useSmartParticipantOrder<T extends ParticipantWithMediaHints>(
  participants: readonly T[],
  activeSpeakerId: string | null,
  options: UseSmartParticipantOrderOptions = {}
): T[] {
  return useSmartParticipantOrderWithMetadata(
    participants,
    activeSpeakerId,
    options,
  ).orderedParticipants;
}
