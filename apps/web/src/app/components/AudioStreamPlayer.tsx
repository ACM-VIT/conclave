"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { useMeetVolume } from "../hooks/useMeetVolume";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import { errorName } from "../lib/utils";

const playerConfigs = {
  participant: {
    playbackErrorMessage: "[Meets] Audio play error:",
    audioOutputErrorMessage: "[Meets] Failed to update audio output:",
    replayOnForeground: false,
    preload: "none",
  },
  screenShare: {
    playbackErrorMessage: "[Meets] Screen share audio play error:",
    audioOutputErrorMessage: "[Meets] Failed to set screen share audio output:",
    replayOnForeground: true,
    preload: undefined,
  },
  system: {
    playbackErrorMessage: "[Meets] System audio play error:",
    audioOutputErrorMessage: "[Meets] Failed to set system audio output:",
    replayOnForeground: true,
    preload: undefined,
  },
} as const;

type AudioStreamPlayerProps = {
  kind: keyof typeof playerConfigs;
  stream: MediaStream | null | undefined;
  audioOutputDeviceId?: string;
  muted?: boolean;
  onAutoplayBlocked?: () => void;
  onPlaybackStarted?: () => void;
  playbackAttemptToken?: number;
  playbackErrorContext?: string;
  restartToken?: string | number | boolean | null;
  elementKey?: string;
};

const hiddenAudioStyle = {
  width: 0,
  height: 0,
  opacity: 0,
  position: "absolute",
  pointerEvents: "none",
} as const;

function AudioStreamPlayer({
  kind,
  stream,
  audioOutputDeviceId,
  muted = false,
  onAutoplayBlocked,
  onPlaybackStarted,
  playbackAttemptToken,
  playbackErrorContext,
  restartToken,
  elementKey,
}: AudioStreamPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayBlockedRef = useRef(false);
  const { meetVolume } = useMeetVolume();
  const {
    audioOutputErrorMessage,
    playbackErrorMessage,
    preload,
    replayOnForeground,
  } = playerConfigs[kind];
  const playbackAudioOutputDeviceId =
    kind === "participant" ? audioOutputDeviceId : undefined;

  const attemptPlayback = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio || !stream || muted) return;

    audio.play()
      .then(() => {
        autoplayBlockedRef.current = false;
        onPlaybackStarted?.();
      })
      .catch((err) => {
        if (errorName(err) === "NotAllowedError") {
          if (!autoplayBlockedRef.current) {
            autoplayBlockedRef.current = true;
            onAutoplayBlocked?.();
          }
          return;
        }
        if (errorName(err) === "AbortError") return;

        if (playbackErrorContext === undefined) {
          console.error(playbackErrorMessage, err);
        } else {
          console.error(playbackErrorMessage, playbackErrorContext, err);
        }
      });
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!stream) {
      autoplayBlockedRef.current = false;
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    autoplayBlockedRef.current = false;
    audio.autoplay = true;
    audio.defaultMuted = muted;
    audio.muted = muted;

    if (audio.srcObject !== stream) {
      audio.srcObject = null;
      audio.srcObject = stream;
    }

    let cancelled = false;
    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: () => {
        if (cancelled) return;
        attemptPlayback();
      },
    });
    const scheduleReplay = playbackRecovery.schedule;
    const audioTrack = stream.getAudioTracks()[0];
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleUserGesture = () => {
      if (autoplayBlockedRef.current) {
        scheduleReplay();
      }
    };

    scheduleReplay();
    audioTrack?.addEventListener("unmute", scheduleReplay);
    audio.addEventListener("loadedmetadata", scheduleReplay);
    audio.addEventListener("loadeddata", scheduleReplay);
    audio.addEventListener("canplay", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (replayOnForeground) {
      window.addEventListener("focus", scheduleReplay);
      window.addEventListener("pageshow", scheduleReplay);
    }
    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      cancelled = true;
      audioTrack?.removeEventListener("unmute", scheduleReplay);
      audio.removeEventListener("loadedmetadata", scheduleReplay);
      audio.removeEventListener("loadeddata", scheduleReplay);
      audio.removeEventListener("canplay", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (replayOnForeground) {
        window.removeEventListener("focus", scheduleReplay);
        window.removeEventListener("pageshow", scheduleReplay);
      }
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
      playbackRecovery.clear();
      if (audio.srcObject === stream) {
        audio.srcObject = null;
      }
    };
  }, [
    elementKey,
    muted,
    playbackAudioOutputDeviceId,
    replayOnForeground,
    restartToken,
    stream,
  ]);

  useEffect(() => {
    const audio = audioRef.current as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (!audio || !stream || !audioOutputDeviceId || !audio.setSinkId) return;

    audio.setSinkId(audioOutputDeviceId).catch((err) => {
      console.error(audioOutputErrorMessage, err);
    });
  }, [
    audioOutputDeviceId,
    audioOutputErrorMessage,
    elementKey,
    restartToken,
    stream,
  ]);

  useEffect(() => {
    if (playbackAttemptToken == null || playbackAttemptToken < 1) return;
    attemptPlayback();
  }, [playbackAttemptToken]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = meetVolume;
  }, [meetVolume]);

  return (
    <audio
      key={elementKey}
      ref={audioRef}
      autoPlay
      playsInline
      muted={muted}
      preload={preload}
      style={hiddenAudioStyle}
    />
  );
}

export default AudioStreamPlayer;
