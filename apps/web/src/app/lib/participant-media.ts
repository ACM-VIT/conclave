"use client";

import type { Participant } from "./types";

type ParticipantVideoState = Pick<
  Participant,
  "videoStream" | "isCameraOff" | "isVideoAdaptivelyPaused"
> & {
  screenShareStream?: MediaStream | null;
};

export function getRenderableParticipantVideoStream(
  participant: ParticipantVideoState,
): MediaStream | null {
  if (participant.isCameraOff) {
    return null;
  }
  return participant.videoStream;
}

export function isRenderingParticipantScreenShare(
  participant: ParticipantVideoState,
  stream: MediaStream | null,
): boolean {
  return Boolean(stream && participant.screenShareStream === stream);
}
