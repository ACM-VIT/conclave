import type { Participant } from "./types";

export const canViewerSeeParticipant = (
  participant: Pick<Participant, "isGhost">,
  viewerIsGhost: boolean,
): boolean => {
  if (!participant.isGhost) {
    return true;
  }
  return viewerIsGhost;
};

export const isRemoteParticipantVisible = (
  participant: Pick<Participant, "userId" | "isGhost">,
  viewerIsGhost: boolean,
  currentUserId: string,
): boolean => {
  if (participant.userId === currentUserId) {
    return true;
  }
  return canViewerSeeParticipant(participant, viewerIsGhost);
};
