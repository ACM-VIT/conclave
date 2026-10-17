"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { useMeetVolume } from "../hooks/useMeetVolume";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import { clampParticipantVolume } from "../lib/meet-volume";
import { telemetry } from "../lib/telemetry";
import { errorName } from "../lib/utils";

// How often to verify that an element with a live, unmuted inbound track is
// actually playing. Media can arrive perfectly (consumer resumed, RTP
// flowing) while the element sits paused — blocked autoplay, a failed play()
// after a sink change — which no transport-level watchdog can see (#177).
const PLAYBACK_WATCHDOG_INTERVAL_MS = 5000;

const playerConfigs = {
  participant: {
    playbackErrorMessage: "[Meets] Audio play error:",
    audioOutputErrorMessage: "[Meets] Failed to update audio output:",
    replayOnForeground: true,
    preload: "auto",
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
  volumeMultiplier?: number;
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
  volumeMultiplier = 1,
}: AudioStreamPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayBlockedRef = useRef(false);
  const reportedStallRef = useRef(false);
  const { meetVolume } = useMeetVolume();
  const {
    audioOutputErrorMessage,
    playbackErrorMessage,
    preload,
    replayOnForeground,
  } = playerConfigs[kind];
  const playbackAudioOutputDeviceId =
    kind === "participant" ? audioOutputDeviceId : undefined;

  const notifyAutoplayBlocked = useEffectEvent(() => {
    onAutoplayBlocked?.();
  });

  const attemptPlayback = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio || !stream || muted) return;

    audio.play()
      .then(() => {
        autoplayBlockedRef.current = false;
        if (reportedStallRef.current) {
          reportedStallRef.current = false;
          telemetry.capture("meet_audio_playback_recovered", { kind });
        }
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
      reportedStallRef.current = false;
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    autoplayBlockedRef.current = false;
    reportedStallRef.current = false;
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
      // Assert playback at both lifecycle edges. The hidden transition happens
      // before background timer throttling and keeps the live media element in
      // the browser's audible-playback path; the visible transition repairs a
      // player suspended by page freezing or an output-device handoff.
      scheduleReplay();
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

    // Watchdog: media flowing but element not playing. Retry playback and
    // surface the blocked state so the UI can offer a one-click fix; report
    // the first stall of each episode to telemetry.
    const watchdogId = window.setInterval(() => {
      if (cancelled) return;
      if (
        !audioTrack ||
        audioTrack.readyState !== "live" ||
        audioTrack.muted
      ) {
        return;
      }
      if (audio.paused && !muted) {
        if (!reportedStallRef.current) {
          reportedStallRef.current = true;
          telemetry.capture("meet_audio_playback_stalled", {
            kind,
            autoplayBlocked: autoplayBlockedRef.current,
          });
        }
        if (autoplayBlockedRef.current) {
          notifyAutoplayBlocked();
        }
        scheduleReplay();
      }
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(watchdogId);
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
    kind,
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
    const participantVolume = clampParticipantVolume(volumeMultiplier);
    audio.volume = Math.min(1, meetVolume * participantVolume);
  }, [elementKey, meetVolume, volumeMultiplier]);

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
