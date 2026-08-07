type ParticipantOrderEntry = {
  userId: string;
};

export const getVisibleRemoteParticipantLimit = ({
  remoteParticipantCount,
  maxRemoteWithoutOverflow,
  isOverflowOpen,
}: {
  remoteParticipantCount: number;
  maxRemoteWithoutOverflow: number;
  isOverflowOpen: boolean;
}): number => {
  const hasOverflow = remoteParticipantCount > maxRemoteWithoutOverflow;
  if (!hasOverflow || isOverflowOpen) {
    return maxRemoteWithoutOverflow;
  }
  return Math.max(0, maxRemoteWithoutOverflow - 1);
};

export const isSpeakerOutsideVisibleWindow = ({
  speakerId,
  participants,
  previousOrder,
  visibleParticipantLimit,
}: {
  speakerId: string;
  participants: readonly ParticipantOrderEntry[];
  previousOrder: ReadonlyMap<string, number>;
  visibleParticipantLimit: number | undefined;
}): boolean => {
  if (visibleParticipantLimit === undefined) return true;
  if (visibleParticipantLimit <= 0) return false;

  const previousIndex = previousOrder.get(speakerId);
  const fallbackIndex = participants.findIndex(
    (participant) => participant.userId === speakerId,
  );
  const currentIndex = previousIndex ?? fallbackIndex;
  return currentIndex >= visibleParticipantLimit;
};

/**
 * Promotes an overflow speaker with a single seat swap instead of moving them
 * to the front and shifting every visible tile.
 */
export const placeParticipantAtVisibleBoundary = <
  T extends ParticipantOrderEntry,
>(
  participants: readonly T[],
  participantId: string | null,
  visibleParticipantLimit: number | undefined,
): T[] => {
  const next = [...participants];
  if (
    !participantId ||
    visibleParticipantLimit === undefined ||
    visibleParticipantLimit <= 0
  ) {
    return next;
  }

  const participantIndex = next.findIndex(
    (participant) => participant.userId === participantId,
  );
  const boundaryIndex = Math.min(visibleParticipantLimit, next.length) - 1;
  if (participantIndex < visibleParticipantLimit || boundaryIndex < 0) {
    return next;
  }

  const boundaryParticipant = next[boundaryIndex];
  const promotedParticipant = next[participantIndex];
  if (!boundaryParticipant || !promotedParticipant) return next;

  next[boundaryIndex] = promotedParticipant;
  next[participantIndex] = boundaryParticipant;
  return next;
};
