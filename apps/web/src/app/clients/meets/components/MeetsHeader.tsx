"use client";

import { Copy } from "lucide-react";
import Image from "next/image";
import { memo, useEffect, useState } from "react";
import VideoSettings from "./video-settings";

interface MeetsHeaderProps {
  isJoined: boolean;
  isAdmin: boolean;
  roomId: string;
  isMirrorCamera: boolean;
  isVideoSettingsOpen: boolean;
  onToggleVideoSettings: () => void;
  onToggleMirror: () => void;
  isCameraOff: boolean;
  displayNameInput: string;
  displayNameStatus: { type: "success" | "error"; message: string } | null;
  isDisplayNameUpdating: boolean;
  canUpdateDisplayName: boolean;
  onDisplayNameInputChange: (value: string) => void;
  onDisplayNameSubmit: () => void;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  onAudioInputDeviceChange: (deviceId: string) => void;
  onAudioOutputDeviceChange: (deviceId: string) => void;
  showShareLink?: boolean;
}

function MeetsHeader({
  isJoined,
  isAdmin,
  roomId,
  isMirrorCamera,
  isVideoSettingsOpen,
  onToggleVideoSettings,
  onToggleMirror,
  isCameraOff,
  displayNameInput,
  displayNameStatus,
  isDisplayNameUpdating,
  canUpdateDisplayName,
  onDisplayNameInputChange,
  onDisplayNameSubmit,
  selectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  showShareLink,
}: MeetsHeaderProps) {
  const [shareUrl, setShareUrl] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [isShareVisible, setIsShareVisible] = useState(true);

  useEffect(() => {
    if (!roomId || typeof window === "undefined") {
      setShareUrl("");
      setIsShareVisible(true);
      return;
    }
    setShareUrl(`${window.location.origin}/${roomId}`);
    setIsShareVisible(true);
  }, [roomId]);

  const handleCopyLink = async () => {
    const target = shareUrl || `/${roomId}`;
    try {
      await navigator.clipboard.writeText(target);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 2000);
      setIsShareVisible(false);
    } catch (_error) {
      setIsCopied(false);
    }
  };

  if (isJoined) {
    const displayShareUrl = shareUrl || `/${roomId}`;
    return (
      <header className="fixed top-0 left-0 right-0 z-[100] pointer-events-none">
        <div className="flex items-center justify-center px-4 pt-1 pb-0 pointer-events-auto">
          <div className="flex items-center gap-3">
            {roomId.trim() && (
              <span
                className="text-[12px] text-[#FEFCD9]/60"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                <span className="text-[#FEFCD9]/30">room</span>{" "}
                <span className="text-[#F95F4A]">{roomId}</span>
              </span>
            )}
            <VideoSettings
              isMirrorCamera={isMirrorCamera}
              isOpen={isVideoSettingsOpen}
              onToggleOpen={onToggleVideoSettings}
              onToggleMirror={onToggleMirror}
              isCameraOff={isCameraOff}
              isAdmin={isAdmin}
              displayNameInput={displayNameInput}
              displayNameStatus={displayNameStatus}
              isDisplayNameUpdating={isDisplayNameUpdating}
              canUpdateDisplayName={canUpdateDisplayName}
              onDisplayNameInputChange={onDisplayNameInputChange}
              onDisplayNameSubmit={onDisplayNameSubmit}
              selectedAudioInputDeviceId={selectedAudioInputDeviceId}
              selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
              onAudioInputDeviceChange={onAudioInputDeviceChange}
              onAudioOutputDeviceChange={onAudioOutputDeviceChange}
            />
          </div>
        </div>
        {showShareLink && isAdmin && roomId.trim() && isShareVisible && (
          <div className="flex justify-center pointer-events-auto">
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm border border-[#FEFCD9]/10 text-[11px] text-[#FEFCD9]/70"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <span className="text-[#FEFCD9]/50">Share link</span>
              <span className="max-w-[220px] truncate text-[#FEFCD9]" title={displayShareUrl}>
                {displayShareUrl}
              </span>
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1 text-[#F95F4A] hover:text-[#ff7a66] transition-colors"
              >
                <Copy className="w-3 h-3" />
                <span>{isCopied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-[100] pointer-events-none">
      <div className="flex items-center justify-between px-4 py-3 pointer-events-auto">
        <a href="/" className="flex items-center">
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM Logo"
            width={128}
            height={128}
          />
        </a>

        {isJoined && (
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3">
            {roomId.trim() && (
              <span 
                className="text-[12px] text-[#FEFCD9]/50"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                <span className="text-[#FEFCD9]/30">room</span>{" "}
                <span className="text-[#F95F4A]">{roomId}</span>
              </span>
            )}
            <VideoSettings
              isMirrorCamera={isMirrorCamera}
              isOpen={isVideoSettingsOpen}
              onToggleOpen={onToggleVideoSettings}
              onToggleMirror={onToggleMirror}
              isCameraOff={isCameraOff}
              isAdmin={isAdmin}
              displayNameInput={displayNameInput}
              displayNameStatus={displayNameStatus}
              isDisplayNameUpdating={isDisplayNameUpdating}
              canUpdateDisplayName={canUpdateDisplayName}
              onDisplayNameInputChange={onDisplayNameInputChange}
              onDisplayNameSubmit={onDisplayNameSubmit}
              selectedAudioInputDeviceId={selectedAudioInputDeviceId}
              selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
              onAudioInputDeviceChange={onAudioInputDeviceChange}
              onAudioOutputDeviceChange={onAudioOutputDeviceChange}
            />
          </div>
        )}

        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end">
            <span 
              className="text-sm text-[#FEFCD9]"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              c0nclav3
            </span>
            <span 
              className="text-[9px] uppercase tracking-[0.15em] text-[#FEFCD9]/40"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              by acm-vit
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default memo(MeetsHeader);
