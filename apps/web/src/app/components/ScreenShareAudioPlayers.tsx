"use client";

import { errorName } from "../lib/utils";
import { memo, useCallback, useEffect, useRef } from "react";
import { useMeetVolume } from "../hooks/useMeetVolume";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import type { Participant } from "../lib/types";

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
  const autoplayBlockedRef = useRef(false);
  const { meetVolume } = useMeetVolume();

  const attemptPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !stream) return;
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
        if (errorName(err) !== "AbortError") {
          console.error("[Meets] Screen share audio play error:", err);
        }
      });
  }, [onAutoplayBlocked, onPlaybackStarted, stream]);

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
    audio.defaultMuted = false;
    audio.muted = false;

    if (audio.srcObject !== stream) {
      audio.srcObject = null;
      audio.srcObject = stream;
    }

    let cancelled = false;
    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: () => {
        if (cancelled) return;
        attemptPlay();
      },
    });
    const scheduleReplay = playbackRecovery.schedule;

    scheduleReplay();

    const audioTrack = stream.getAudioTracks()[0];
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleForegroundReplay = () => {
      scheduleReplay();
    };
    const handleUserGesture = () => {
      if (!autoplayBlockedRef.current) return;
      scheduleReplay();
    };

    audioTrack?.addEventListener("unmute", scheduleReplay);
    audio.addEventListener("loadedmetadata", scheduleReplay);
    audio.addEventListener("loadeddata", scheduleReplay);
    audio.addEventListener("canplay", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleForegroundReplay);
    window.addEventListener("pageshow", handleForegroundReplay);
    window.addEventListener("pointerdown", handleUserGesture, true);
    window.addEventListener("keydown", handleUserGesture, true);

    return () => {
      cancelled = true;
      audioTrack?.removeEventListener("unmute", scheduleReplay);
      audio.removeEventListener("loadedmetadata", scheduleReplay);
      audio.removeEventListener("loadeddata", scheduleReplay);
      audio.removeEventListener("canplay", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleForegroundReplay);
      window.removeEventListener("pageshow", handleForegroundReplay);
      window.removeEventListener("pointerdown", handleUserGesture, true);
      window.removeEventListener("keydown", handleUserGesture, true);
      playbackRecovery.clear();
      if (audio.srcObject === stream) {
        audio.srcObject = null;
      }
    };
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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = meetVolume;
  }, [meetVolume]);

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
