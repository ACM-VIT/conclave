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
          console.error("[Meets] Audio play error:", participant.userId, err);
        }
      });
  }, [
    onAudioAutoplayBlocked,
    onAudioPlaybackStarted,
    participant.audioStream,
    participant.userId,
  ]);

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

    let cancelled = false;
    const replayTimeouts: number[] = [];

    const scheduleReplay = () => {
      if (cancelled) return;
      attemptAudioPlayback();
      if (typeof window !== "undefined") {
        for (const delay of [80, 220, 480, 900, 1500]) {
          replayTimeouts.push(window.setTimeout(attemptAudioPlayback, delay));
        }
      }
    };

    scheduleReplay();

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
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handlePlaybackEvent = () => {
      scheduleReplay();
    };

    if (audioTrack) {
      audioTrack.addEventListener("unmute", scheduleReplay);
    }
    audio.addEventListener("loadedmetadata", handlePlaybackEvent);
    audio.addEventListener("loadeddata", handlePlaybackEvent);
    audio.addEventListener("canplay", handlePlaybackEvent);
    audio.addEventListener("stalled", handlePlaybackEvent);
    audio.addEventListener("suspend", handlePlaybackEvent);
    audio.addEventListener("pause", handlePlaybackEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      if (audioTrack) {
        audioTrack.removeEventListener("unmute", scheduleReplay);
      }
      audio.removeEventListener("loadedmetadata", handlePlaybackEvent);
      audio.removeEventListener("loadeddata", handlePlaybackEvent);
      audio.removeEventListener("canplay", handlePlaybackEvent);
      audio.removeEventListener("stalled", handlePlaybackEvent);
      audio.removeEventListener("suspend", handlePlaybackEvent);
      audio.removeEventListener("pause", handlePlaybackEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      for (const timeoutId of replayTimeouts) {
        window.clearTimeout(timeoutId);
      }
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
