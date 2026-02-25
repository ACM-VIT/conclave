"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import type { Participant } from "../lib/types";

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
  const audioRef = useRef<HTMLAudioElement>(null);

  const attemptAudioPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !participant.audioStream) return;
    audio.play()
      .then(() => {
        onAudioPlaybackStarted?.();
      })
      .catch((err) => {
        if (err.name === "NotAllowedError") {
          onAudioAutoplayBlocked?.();
          return;
        }
        if (err.name !== "AbortError") {
          console.error("[Meets] Audio play error:", err);
        }
      });
  }, [onAudioAutoplayBlocked, onAudioPlaybackStarted, participant.audioStream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!participant.audioStream) {
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    if (audio.srcObject !== participant.audioStream) {
      audio.srcObject = participant.audioStream;
    }

    attemptAudioPlayback();

    if (audioOutputDeviceId) {
      const audioElement = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioElement.setSinkId) {
        audioElement.setSinkId(audioOutputDeviceId).catch((err) => {
          console.error("[Meets] Failed to update audio output:", err);
        });
      }
    }

    const audioTrack = participant.audioStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.addEventListener("unmute", attemptAudioPlayback);

    return () => {
      audioTrack.removeEventListener("unmute", attemptAudioPlayback);
    };
  }, [
    participant.audioStream,
    participant.audioProducerId,
    participant.isMuted,
    audioOutputDeviceId,
    attemptAudioPlayback,
  ]);

  useEffect(() => {
    if (audioPlaybackAttemptToken == null || audioPlaybackAttemptToken < 1) return;
    attemptAudioPlayback();
  }, [audioPlaybackAttemptToken, attemptAudioPlayback]);

  return <audio ref={audioRef} autoPlay />;
}

export default memo(ParticipantAudio);
