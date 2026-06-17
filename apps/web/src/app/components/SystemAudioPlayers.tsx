"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";

interface SystemAudioPlayersProps {
  participants: Map<string, Participant>;
  audioOutputDeviceId?: string;
  muted?: boolean;
  onAutoplayBlocked?: () => void;
}

function SystemAudioPlayers({
  participants,
  audioOutputDeviceId,
  muted = false,
  onAutoplayBlocked,
}: SystemAudioPlayersProps) {
  const systemAudioParticipants = Array.from(participants.values()).filter(
    (participant) => isSystemUserId(participant.userId) && participant.audioStream
  );

  return (
    <>
      {systemAudioParticipants.map((participant) => (
        <SystemAudioPlayer
          key={participant.userId}
          stream={participant.audioStream}
          audioOutputDeviceId={audioOutputDeviceId}
          muted={muted}
          onAutoplayBlocked={onAutoplayBlocked}
        />
      ))}
    </>
  );
}

interface SystemAudioPlayerProps {
  stream: MediaStream | null;
  audioOutputDeviceId?: string;
  muted: boolean;
  onAutoplayBlocked?: () => void;
}

function SystemAudioPlayer({
  stream,
  audioOutputDeviceId,
  muted,
  onAutoplayBlocked,
}: SystemAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!stream) {
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    audio.srcObject = stream;
    audio.play().catch((err) => {
      if (err.name === "NotAllowedError") {
        setBlocked(true);
        onAutoplayBlocked?.();
        return;
      }
      if (err.name !== "AbortError") {
        console.error("[Meets] System audio play error:", err);
      }
    });
    return () => {
      if (audio.srcObject === stream) {
        audio.srcObject = null;
      }
    };
  }, [stream, onAutoplayBlocked]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    if (!muted && stream) {
      const attemptPlay = () => {
        audio.play().catch((err) => {
          if (err.name === "NotAllowedError") {
            setBlocked(true);
            onAutoplayBlocked?.();
            return;
          }
          if (err.name !== "AbortError") {
            console.error("[Meets] System audio play error:", err);
          }
        });
      };
      if (blocked) {
        setBlocked(false);
      }
      attemptPlay();
    }
  }, [muted, stream]);

  useEffect(() => {
    const audio = audioRef.current as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (!audio || !audioOutputDeviceId || !audio.setSinkId) return;
    audio.setSinkId(audioOutputDeviceId).catch((err) => {
      console.error("[Meets] Failed to set system audio output:", err);
    });
  }, [audioOutputDeviceId]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      muted={muted}
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

export default memo(SystemAudioPlayers);
