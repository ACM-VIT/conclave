"use client";

import { memo } from "react";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import AudioStreamPlayer from "./AudioStreamPlayer";

interface SystemAudioPlayersProps {
  participants: Map<string, Participant>;
  audioOutputDeviceId?: string;
  muted?: boolean;
  onAutoplayBlocked?: () => void;
  onPlaybackStarted?: () => void;
  playbackAttemptToken?: number;
}

function SystemAudioPlayers({
  participants,
  audioOutputDeviceId,
  muted = false,
  onAutoplayBlocked,
  onPlaybackStarted,
  playbackAttemptToken,
}: SystemAudioPlayersProps) {
  const systemAudioParticipants = Array.from(participants.values()).filter(
    (participant) => isSystemUserId(participant.userId) && participant.audioStream
  );

  return (
    <>
      {systemAudioParticipants.map((participant) => (
        <AudioStreamPlayer
          key={participant.userId}
          kind="system"
          stream={participant.audioStream}
          audioOutputDeviceId={audioOutputDeviceId}
          muted={muted}
          onAutoplayBlocked={onAutoplayBlocked}
          onPlaybackStarted={onPlaybackStarted}
          playbackAttemptToken={playbackAttemptToken}
        />
      ))}
    </>
  );
}

export default memo(SystemAudioPlayers);
