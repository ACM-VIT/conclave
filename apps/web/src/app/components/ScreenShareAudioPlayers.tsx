"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import type { Participant } from "../lib/types";

interface ScreenShareAudioPlayersProps {
  participants: Map<string, Participant>;
  audioOutputDeviceId?: string;
  onAutoplayBlocked?: () => void;
  onPlaybackStarted?: () => void;
  playbackAttemptToken?: number;
}

function ScreenShareAudioPlayers({
  participants,
  audioOutputDeviceId,
  onAutoplayBlocked,
  onPlaybackStarted,
  playbackAttemptToken,
}: ScreenShareAudioPlayersProps) {
  const screenShareAudioParticipants = Array.from(participants.values()).filter(
    (participant) => participant.screenShareAudioStream
  );

  return (
    <>
      {screenShareAudioParticipants.map((participant) => (
        <ScreenShareAudioPlayer
          key={
            participant.screenShareAudioProducerId ??
            `${participant.userId}-screen-audio`
          }
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

interface ScreenShareAudioPlayerProps {
  stream: MediaStream | null;
  audioOutputDeviceId?: string;
  onAutoplayBlocked?: () => void;
  onPlaybackStarted?: () => void;
  playbackAttemptToken?: number;
}

function ScreenShareAudioPlayer({
  stream,
  audioOutputDeviceId,
  onAutoplayBlocked,
  onPlaybackStarted,
  playbackAttemptToken,
}: ScreenShareAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  const attemptPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !stream) return;
    audio.play()
      .then(() => {
        onPlaybackStarted?.();
      })
      .catch((err) => {
        if (err.name === "NotAllowedError") {
          onAutoplayBlocked?.();
          return;
        }
        if (err.name !== "AbortError") {
          console.error("[Meets] Screen share audio play error:", err);
        }
      });
  }, [onAutoplayBlocked, onPlaybackStarted, stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !stream) return;
    audio.srcObject = stream;
    attemptPlay();
  }, [stream, attemptPlay]);

  useEffect(() => {
    if (playbackAttemptToken == null || playbackAttemptToken < 1) return;
    attemptPlay();
  }, [playbackAttemptToken, attemptPlay]);

  useEffect(() => {
    const audio = audioRef.current as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (!audio || !audioOutputDeviceId || !audio.setSinkId) return;
    audio.setSinkId(audioOutputDeviceId).catch((err) => {
      console.error("[Meets] Failed to set screen share audio output:", err);
    });
  }, [audioOutputDeviceId]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      style={{
        width: 0,
        height: 0,
        opacity: 0,
        position: "absolute",
        pointerEvents: "none",
      }}
    />
  );
}

export default memo(ScreenShareAudioPlayers);
