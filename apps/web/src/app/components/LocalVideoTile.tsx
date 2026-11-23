"use client";

import { Hand, MicOff, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useRef, type CSSProperties } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { truncateDisplayName } from "../lib/utils";
import GameTileOverlay from "./games/GameTileOverlay";

type LocalVideoTileTracking = {
  active: boolean;
  source: string;
};

function LocalVideoTile({
  stream,
  isCameraOff,
  isMuted,
  isHandRaised,
  isMirrorCamera,
  displayName,
  userEmail,
  isActiveSpeaker = false,
  isPinned = false,
  onTogglePin,
  tracking,
  cropPosition = null,
  videoObjectFit = "cover",
  size = "rail",
}: {
  stream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isMirrorCamera: boolean;
  displayName: string;
  userEmail: string;
  isActiveSpeaker?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  tracking?: LocalVideoTileTracking;
  cropPosition?: string | null;
  videoObjectFit?: "cover" | "contain";
  size?: "rail" | "stage";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrack = stream?.getVideoTracks()[0] ?? null;

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

    const playVideo = () => {
      video.play().catch(() => {});
    };

    playVideo();
    videoTrack?.addEventListener("unmute", playVideo);

    return () => {
      videoTrack?.removeEventListener("unmute", playVideo);
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [isCameraOff, stream, videoTrack]);

  const compact = size === "rail";
  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = isHandRaised ? "!border-amber-400/60" : "";
  const videoStyle: CSSProperties | undefined = cropPosition
    ? { objectPosition: cropPosition }
    : undefined;

  return (
    <div
      className={`acm-video-tile group relative flex overflow-hidden bg-[#18181b] ${
        compact ? "h-28 shrink-0" : "h-full w-full"
      } ${speakerHighlight} ${handRaisedHighlight}`}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-meet-local-tracking={tracking?.active ? "true" : "false"}
        data-meet-local-tracking-source={tracking?.source ?? "none"}
        data-meet-local-crop-position={cropPosition ?? ""}
        style={videoStyle}
        className={`h-full w-full ${
          videoObjectFit === "contain" ? "object-contain bg-black" : "object-cover"
        } ${
          isCameraOff ? "hidden" : ""
        } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
      />
      {isCameraOff ? (
        <div
          data-meet-local-camera-placeholder="true"
          className="absolute inset-0 flex items-center justify-center bg-[#18181b]"
        >
          <Avatar
            className={compact ? "text-xl" : "text-3xl"}
            id={userEmail}
            name={displayName || userEmail}
            size={compact ? 48 : 80}
          />
        </div>
      ) : null}
      {isHandRaised ? (
        <div
          className={`absolute flex items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300 ${
            compact ? "left-2 top-2 h-7 w-7" : "left-3 top-3 h-8 w-8"
          }`}
          title="Hand raised"
          aria-label="Hand raised"
        >
          <Hand size={compact ? 16 : 18} strokeWidth={1.75} />
        </div>
      ) : null}
      {onTogglePin ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          className={`absolute rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
            compact ? "right-2 top-2 p-1.5" : "right-3 top-3 p-2"
          } ${isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-pressed={isPinned}
        >
          {isPinned ? (
            <PinOff className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          ) : (
            <Pin className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          )}
        </button>
      ) : null}
      <div
        className={`absolute flex max-w-[85%] items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 ${
          compact ? "bottom-2 left-2 px-2.5 py-1" : "bottom-3 left-3 px-3 py-1.5"
        }`}
      >
        <span
          className={`truncate font-medium text-[#fafafa] ${
            compact ? "text-[12.5px]" : "text-[13px]"
          }`}
        >
          {truncateDisplayName(displayName, compact ? 18 : 24)}
        </span>
        <span className="text-[10.5px] font-medium text-[#F95F4A]">You</span>
        {isActiveSpeaker && !isMuted ? (
          <span className="acm-voice-activity" aria-label="Speaking">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {isMuted ? (
          <MicOff
            size={compact ? 13 : 14}
            strokeWidth={1.75}
            className="shrink-0 text-[#F95F4A]"
          />
        ) : null}
      </div>
      <GameTileOverlay compact={compact} />
    </div>
  );
}

export default memo(LocalVideoTile);
