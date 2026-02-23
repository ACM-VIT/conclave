import { useEffect, useMemo, useRef, useState } from "react";

interface ParticipantLike {
  userId: string;
  videoStream: MediaStream | null;
  audioStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
}

interface UseSmartParticipantOrderOptions {
  promoteDelayMs?: number;
  minSwitchIntervalMs?: number;
}

const hasLiveTrack = (
  stream: MediaStream | null,
  kind: "audio" | "video"
): boolean => {
  if (!stream) return false;
  const track = kind === "video" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
  return Boolean(track && track.enabled && track.readyState === "live");
};

const getMediaPriority = (participant: ParticipantLike): number => {
  const hasVideo = !participant.isCameraOff && hasLiveTrack(participant.videoStream, "video");
  if (hasVideo) return 2;
  const hasAudio = !participant.isMuted && hasLiveTrack(participant.audioStream, "audio");
  if (hasAudio) return 1;
  return 0;
};

export function useSmartParticipantOrder<T extends ParticipantLike>(
  participants: readonly T[],
  activeSpeakerId: string | null,
  options: UseSmartParticipantOrderOptions = {}
): T[] {
  const { promoteDelayMs = 700, minSwitchIntervalMs = 2200 } = options;
  const participantIdsKey = useMemo(
    () => participants.map((participant) => participant.userId).join("|"),
    [participants]
  );
  const [featuredSpeakerId, setFeaturedSpeakerId] = useState<string | null>(null);
  const participantsRef = useRef(participants);
  const featuredSpeakerIdRef = useRef<string | null>(null);
  const candidateIdRef = useRef<string | null>(null);
  const candidateSinceRef = useRef(0);
  const lastSwitchAtRef = useRef(0);
  const promoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOrderRef = useRef<Map<string, number>>(new Map());

  const clearPromoteTimeout = () => {
    if (promoteTimeoutRef.current) {
      clearTimeout(promoteTimeoutRef.current);
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
    clearPromoteTimeout();

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
        promoteTimeoutRef.current = setTimeout(
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
    promoteTimeoutRef.current = setTimeout(attemptPromotion, waitMs);

    return () => {
      clearPromoteTimeout();
    };
  }, [activeSpeakerId, participantIdsKey, promoteDelayMs, minSwitchIntervalMs]);

  const orderedParticipants = useMemo(() => {
    const inputOrder = new Map(
      participants.map((participant, index) => [participant.userId, index] as const)
    );
    const previousOrder = previousOrderRef.current;

    return [...participants].sort((left, right) => {
      const leftIsFeatured = left.userId === featuredSpeakerId ? 1 : 0;
      const rightIsFeatured = right.userId === featuredSpeakerId ? 1 : 0;
      if (leftIsFeatured !== rightIsFeatured) {
        return rightIsFeatured - leftIsFeatured;
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
  }, [participants, featuredSpeakerId]);

  useEffect(() => {
    previousOrderRef.current = new Map(
      orderedParticipants.map((participant, index) => [participant.userId, index] as const)
    );
  }, [orderedParticipants]);

  return orderedParticipants;
}
