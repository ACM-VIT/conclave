"use client";

import { memo } from "react";
import type { Participant } from "../lib/types";
import AudioStreamPlayer from "./AudioStreamPlayer";

interface ParticipantAudioProps {
  participant: Participant;
  audioOutputDeviceId?: string;
  onAudioAutoplayBlocked?: () => void;
  onAudioPlaybackStarted?: () => void;
  audioPlaybackAttemptToken?: number;
}

function ParticipantAudio({
  participant,
  audioOutputDeviceId,
  onAudioAutoplayBlocked,
  onAudioPlaybackStarted,
  audioPlaybackAttemptToken,
}: ParticipantAudioProps) {
  const audioTrackId = participant.audioStream?.getAudioTracks()[0]?.id ?? "none";
  const audioElementKey = `${participant.audioProducerId ?? participant.userId}:${audioTrackId}`;
  const restartToken = `${participant.audioProducerId ?? ""}:${participant.isMuted}`;

  return (
    <AudioStreamPlayer
      kind="participant"
      stream={participant.audioStream}
      audioOutputDeviceId={audioOutputDeviceId}
      onAutoplayBlocked={onAudioAutoplayBlocked}
      onPlaybackStarted={onAudioPlaybackStarted}
      playbackAttemptToken={audioPlaybackAttemptToken}
      playbackErrorContext={participant.userId}
      restartToken={restartToken}
      elementKey={audioElementKey}
    />
  );
}

export default memo(ParticipantAudio);
