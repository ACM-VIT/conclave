"use client";

import { Hand, MicOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { truncateDisplayName } from "../lib/utils";
import GameTileOverlay from "./games/GameTileOverlay";

interface RailLocalTileProps {
  stream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isMirrorCamera: boolean;
  isActiveSpeaker: boolean;
  displayName: string;
  userEmail: string;
}

/**
 * The local participant's tile for app side rails (watch, whiteboard), styled
 * identically to the compact ParticipantVideo tiles it sits beside: same tile
 * chrome and speaking treatment, same name pill with the coral You tag, the
 * voice activity waves, and the mute icon.
 */
function RailLocalTile({
  stream,
  isCameraOff,
  isMuted,
  isHandRaised,
  isMirrorCamera,
  isActiveSpeaker,
  displayName,
  userEmail,
}: RailLocalTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!stream || isCameraOff) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(() => {});

    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream, isCameraOff]);

  return (
    <div
      className={`acm-video-tile group relative h-36 w-48 shrink-0 sm:w-auto ${
        isActiveSpeaker ? "speaking" : ""
      } ${isHandRaised ? "!border-amber-400/60" : ""}`}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`h-full w-full object-cover ${isCameraOff ? "hidden" : ""} ${
          isMirrorCamera ? "scale-x-[-1]" : ""
        }`}
      />
      {isCameraOff && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#18181b]">
          <Avatar
            className="text-lg"
            id={userEmail}
            name={displayName || userEmail}
            size={48}
          />
        </div>
      )}
      {isHandRaised && (
        <div
          className="absolute left-3 top-3 rounded-full border border-amber-400/40 bg-amber-500/20 p-1.5 text-amber-300"
          title="Hand raised"
        >
          <Hand className="h-3 w-3" />
        </div>
      )}
      <div className="absolute bottom-3 left-3 flex max-w-[85%] items-center gap-2 rounded-full border border-[#fafafa]/10 bg-black/70 px-3 py-1.5 text-[10px]">
        <span className="truncate font-medium text-[#fafafa]" title={displayName}>
          {truncateDisplayName(displayName, 12)}
        </span>
        <span className="shrink-0 font-medium text-[#F95F4A]">You</span>
        {isActiveSpeaker && !isMuted && (
          <span className="acm-voice-activity" aria-label="Speaking">
            <span />
            <span />
            <span />
          </span>
        )}
        {isMuted && <MicOff className="h-3 w-3 shrink-0 text-[#F95F4A]" />}
      </div>
      <GameTileOverlay compact />
    </div>
  );
}

export default memo(RailLocalTile);
