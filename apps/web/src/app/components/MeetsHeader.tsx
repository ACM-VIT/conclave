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
  canSignOut: boolean;
  isSigningOut: boolean;
  onSignOut: () => void;
  onLogin?: () => void;
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
  canSignOut,
  isSigningOut,
  onSignOut,
  onLogin,
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
        <div className="flex items-center justify-center px-4 pt-0 pointer-events-auto">
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
            {showShareLink && isAdmin && roomId.trim() && isShareVisible && (
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm border border-[#FEFCD9]/10 text-[11px] text-[#FEFCD9]/70"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                <span className="text-[#FEFCD9]/50">Share link</span>
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 text-[#F95F4A] hover:text-[#ff7a66] transition-colors"
                  title={displayShareUrl}
                >
                  <Copy className="w-3 h-3" />
                  <span>{isCopied ? "Copied" : "Copy"}</span>
                </button>
              </div>
            )}
          </div>
        </div>
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

        <div className="flex items-center gap-4">
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
          {canSignOut ? (
            <button
              onClick={onSignOut}
              disabled={isSigningOut}
              className="px-3 py-1.5 rounded-full bg-[#1a1a1a]/80 border border-[#FEFCD9]/10 text-[10px] uppercase tracking-widest text-[#FEFCD9]/70 hover:text-[#FEFCD9] hover:border-[#FEFCD9]/30 transition-colors disabled:opacity-50"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              {isSigningOut ? "Signing out..." : "Sign out"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onLogin}
              className="px-4 py-2 rounded-full bg-[#1a1a1a]/80 border border-[#FEFCD9]/10 text-[11px] uppercase tracking-widest text-[#FEFCD9]/70 hover:text-[#FEFCD9] hover:border-[#FEFCD9]/30 transition-colors"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Log in
            </button>
          )}
        </div>
      </div>

      <div className="fixed left-5 bottom-4 pointer-events-none">
        <div className="flex flex-col items-start">
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
    </header>
  );
}

export default memo(MeetsHeader);
