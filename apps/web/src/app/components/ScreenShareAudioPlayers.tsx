"use client";

import { memo } from "react";
import type { Participant } from "../lib/types";
import AudioStreamPlayer from "./AudioStreamPlayer";

interface ScreenShareAudioPlayersProps {
  participants: Map<string, Participant>;
  currentUserId: string;
  activeScreenShareId: string | null;
  audioOutputDeviceId?: string;
  onAutoplayBlocked?: () => void;
  onPlaybackStarted?: () => void;
  playbackAttemptToken?: number;
}

const hasLiveAudio = (stream: MediaStream | null | undefined) => {
  const track = stream?.getAudioTracks()[0];
  return Boolean(track && track.readyState === "live");
};

function ScreenShareAudioPlayers({
  participants,
  currentUserId,
  activeScreenShareId,
  audioOutputDeviceId,
  onAutoplayBlocked,
  onPlaybackStarted,
  playbackAttemptToken,
}: ScreenShareAudioPlayersProps) {
  const screenShareAudioParticipants = Array.from(participants.values()).filter(
    (participant) =>
      participant.userId !== currentUserId &&
      hasLiveAudio(participant.screenShareAudioStream) &&
      (!activeScreenShareId ||
        participant.screenShareProducerId === activeScreenShareId)
  );

  return (
    <>
      {screenShareAudioParticipants.map((participant) => (
        <AudioStreamPlayer
          key={
            participant.screenShareAudioProducerId ??
            `${participant.userId}-screen-audio`
          }
          kind="screenShare"
          stream={participant.screenShareAudioStream}
          audioOutputDeviceId={audioOutputDeviceId}
          onAutoplayBlocked={onAutoplayBlocked}
          onPlaybackStarted={onPlaybackStarted}
          playbackAttemptToken={playbackAttemptToken}
        />
      ))}
    </>
  );
}

export default memo(ScreenShareAudioPlayers);
