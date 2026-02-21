"use client";

import { Lock, MessageSquareLock, ShieldBan, VolumeX, X } from "lucide-react";

interface MeetSettingsPanelProps {
  isRoomLocked: boolean;
  onToggleLock?: () => void;
  isNoGuests: boolean;
  onToggleNoGuests?: () => void;
  isChatLocked: boolean;
  onToggleChatLock?: () => void;
  isTtsDisabled: boolean;
  onToggleTtsDisabled?: () => void;
  onClose: () => void;
}

export default function MeetSettingsPanel({
  isRoomLocked,
  onToggleLock,
  isNoGuests,
  onToggleNoGuests,
  isChatLocked,
  onToggleChatLock,
  isTtsDisabled,
  onToggleTtsDisabled,
  onClose,
}: MeetSettingsPanelProps) {
  return (
    <div
      className="absolute bottom-14 left-1/2 -translate-x-1/2 z-50 w-[260px] rounded-xl border border-white/10 bg-[#0f0f0f]/95 p-2.5 shadow-xl backdrop-blur-md"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <p
            className="text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/45"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Meeting settings
          </p>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[#FEFCD9]/45 transition hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
          aria-label="Close meeting settings"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-1">
        <button
          type="button"
          onClick={onToggleLock}
          disabled={!onToggleLock}
          aria-pressed={isRoomLocked}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-[#FEFCD9]/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            <Lock
              className={`h-4 w-4 ${
                isRoomLocked ? "text-amber-300" : "text-[#FEFCD9]/60"
              }`}
            />
            <span className="text-[#FEFCD9]">Lock meeting</span>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              isRoomLocked
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-[#FEFCD9]/40"
            }`}
          >
            {isRoomLocked ? "On" : "Off"}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleNoGuests}
          disabled={!onToggleNoGuests}
          aria-pressed={isNoGuests}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-[#FEFCD9]/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            <ShieldBan
              className={`h-4 w-4 ${
                isNoGuests ? "text-amber-300" : "text-[#FEFCD9]/60"
              }`}
            />
            <span className="text-[#FEFCD9]">Block guests</span>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              isNoGuests
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-[#FEFCD9]/40"
            }`}
          >
            {isNoGuests ? "On" : "Off"}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleChatLock}
          disabled={!onToggleChatLock}
          aria-pressed={isChatLocked}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-[#FEFCD9]/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            <MessageSquareLock
              className={`h-4 w-4 ${
                isChatLocked ? "text-amber-300" : "text-[#FEFCD9]/60"
              }`}
            />
            <span className="text-[#FEFCD9]">Lock chat</span>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              isChatLocked
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-[#FEFCD9]/40"
            }`}
          >
            {isChatLocked ? "On" : "Off"}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleTtsDisabled}
          disabled={!onToggleTtsDisabled}
          aria-pressed={isTtsDisabled}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-[#FEFCD9]/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            <VolumeX
              className={`h-4 w-4 ${
                isTtsDisabled ? "text-amber-300" : "text-[#FEFCD9]/60"
              }`}
            />
            <span className="text-[#FEFCD9]">Disable text-to-speech</span>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              isTtsDisabled
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-[#FEFCD9]/40"
            }`}
          >
            {isTtsDisabled ? "On" : "Off"}
          </span>
        </button>
      </div>
    </div>
  );
}
