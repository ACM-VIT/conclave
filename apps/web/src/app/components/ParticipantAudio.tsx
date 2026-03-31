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
  const autoplayBlockedRef = useRef(false);

  const attemptAudioPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !participant.audioStream) return;
    audio.play()
      .then(() => {
        autoplayBlockedRef.current = false;
        onAudioPlaybackStarted?.();
      })
      .catch((err) => {
        if (err.name === "NotAllowedError") {
          if (!autoplayBlockedRef.current) {
            autoplayBlockedRef.current = true;
            onAudioAutoplayBlocked?.();
          }
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
      autoplayBlockedRef.current = false;
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    autoplayBlockedRef.current = false;
    audio.autoplay = true;
    audio.defaultMuted = false;
    audio.muted = false;
    audio.volume = 1;

    if (audio.srcObject !== participant.audioStream) {
      // Force a clean re-attach when the remote track changes. Firefox is
      // noticeably less tolerant of keeping a stale MediaStream on the element.
      audio.srcObject = null;
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
    const handleUserGesture = () => {
      if (!autoplayBlockedRef.current) return;
      scheduleReplay();
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
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      cancelled = true;
      if (audioTrack) {
        audioTrack.removeEventListener("unmute", scheduleReplay);
      }
      audio.removeEventListener("loadedmetadata", handlePlaybackEvent);
      audio.removeEventListener("loadeddata", handlePlaybackEvent);
      audio.removeEventListener("canplay", handlePlaybackEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
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

  const audioTrackId = participant.audioStream?.getAudioTracks()[0]?.id ?? "none";

  return (
    <audio
      key={`${participant.audioProducerId ?? participant.userId}:${audioTrackId}`}
      ref={audioRef}
      autoPlay
      playsInline
      preload="none"
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

export default memo(ParticipantAudio);
