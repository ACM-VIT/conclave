"use client";

import { Pause, Play, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MeetingMusicState } from "../lib/types";

interface MeetingMusicPlayerProps {
  state: MeetingMusicState;
  isAdmin: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  onStop?: () => void;
}

export default function MeetingMusicPlayer({
  state,
  isAdmin,
  activeSpeakerId,
  currentUserId,
  onStop,
}: MeetingMusicPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const track = state.track;
  const shouldDuck = Boolean(
    track && activeSpeakerId && activeSpeakerId !== currentUserId,
  );
  const volume = shouldDuck ? 0.35 : 0.82;
  const requestedBy = track?.requestedByDisplayName || "Someone";
  const title = track?.title || "";
  const canPlay = Boolean(track?.url);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) {
      setIsPlaying(false);
      setNeedsGesture(false);
      return;
    }
    audio.volume = volume;
  }, [track, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track?.url) return;
    setNeedsGesture(false);
    void audio.play().then(
      () => setIsPlaying(true),
      () => {
        setIsPlaying(false);
        setNeedsGesture(true);
      },
    );
  }, [track?.id, track?.url]);

  const status = useMemo(() => {
    if (!track) return null;
    if (needsGesture) return "Tap to start";
    return shouldDuck ? "Ducked while someone speaks" : "Playing for everyone";
  }, [needsGesture, shouldDuck, track]);

  if (!track || state.permission === "off") {
    return null;
  }

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || !canPlay) return;
    if (audio.paused) {
      void audio.play().then(
        () => {
          setIsPlaying(true);
          setNeedsGesture(false);
        },
        () => setNeedsGesture(true),
      );
      return;
    }
    audio.pause();
    setIsPlaying(false);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[68] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-3 rounded-xl border border-[#F95F4A]/30 bg-[#18181b]/95 px-3 py-2 shadow-2xl shadow-black/30 backdrop-blur">
        <audio
          ref={audioRef}
          src={track.url}
          preload="auto"
          loop
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
        <button
          type="button"
          onClick={togglePlayback}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] text-white transition-colors hover:bg-[#f24b35]"
          aria-label={isPlaying ? "Pause room music" : "Play room music"}
          title={isPlaying ? "Pause room music" : "Play room music"}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Volume2 size={14} className="shrink-0 text-[#F95F4A]" />
            <p className="truncate text-[13px] font-semibold text-[#fafafa]">
              {title}
            </p>
          </div>
          <p className="truncate text-[11.5px] text-[#a1a1aa]">
            {status} by {requestedBy}
          </p>
        </div>
        {isAdmin && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
            aria-label="Stop room music"
            title="Stop room music"
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
