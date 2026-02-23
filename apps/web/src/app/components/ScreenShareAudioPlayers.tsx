"use client";

import { memo, useEffect, useRef } from "react";
import type { Participant } from "../lib/types";

interface ScreenShareAudioPlayersProps {
  participants: Map<string, Participant>;
  audioOutputDeviceId?: string;
}

function ScreenShareAudioPlayers({
  participants,
  audioOutputDeviceId,
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
        />
      ))}
    </>
  );
}

interface ScreenShareAudioPlayerProps {
  stream: MediaStream | null;
  audioOutputDeviceId?: string;
}

function ScreenShareAudioPlayer({
  stream,
  audioOutputDeviceId,
}: ScreenShareAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !stream) return;
    audio.srcObject = stream;
    audio.play().catch((err) => {
      if (err.name !== "AbortError") {
        console.error("[Meets] Screen share audio play error:", err);
      }
    });
  }, [stream]);

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
