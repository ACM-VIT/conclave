"use client";

import { Hand, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useRef, type CSSProperties } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { useElementSize } from "../hooks/useElementSize";
import { computeTileChrome } from "../lib/tile-chrome";
import GameTileOverlay from "./games/GameTileOverlay";
import TileNameplate from "./TileNameplate";

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
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const tileSize = useElementSize(tileRef);
  const { dense, avatarSize, avatarLift } = computeTileChrome(tileSize);
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

  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = isHandRaised ? "!border-amber-400/60" : "";
  const videoStyle: CSSProperties | undefined = cropPosition
    ? { objectPosition: cropPosition }
    : undefined;

  return (
    <div
      ref={tileRef}
      className={`acm-video-tile group relative flex h-full w-full overflow-hidden bg-[#18181b] ${speakerHighlight} ${handRaisedHighlight}`}
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
          <div
            style={
              avatarLift > 0
                ? { transform: `translateY(-${avatarLift}px)` }
                : undefined
            }
          >
            <Avatar
              className={dense ? "text-lg" : "text-3xl"}
              id={userEmail}
              name={displayName || userEmail}
              size={avatarSize}
            />
          </div>
        </div>
      ) : null}
      {isHandRaised ? (
        <div
          className={`absolute flex items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300 ${
            dense ? "left-2 top-2 h-7 w-7" : "left-3 top-3 h-8 w-8"
          }`}
          title="Hand raised"
          aria-label="Hand raised"
        >
          <Hand size={dense ? 16 : 18} strokeWidth={1.75} />
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
            dense ? "right-2 top-2 p-1.5" : "right-3 top-3 p-2"
          } ${isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-pressed={isPinned}
        >
          {isPinned ? (
            <PinOff className={dense ? "h-3.5 w-3.5" : "h-4 w-4"} />
          ) : (
            <Pin className={dense ? "h-3.5 w-3.5" : "h-4 w-4"} />
          )}
        </button>
      ) : null}
      <TileNameplate
        name={displayName}
        dense={dense}
        isLocal
        isMuted={isMuted}
        isSpeaking={isActiveSpeaker && !isMuted}
      />
      <GameTileOverlay compact={dense} />
    </div>
  );
}

export default memo(LocalVideoTile);
