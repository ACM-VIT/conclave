"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import {
  Settings,
  FlipHorizontal,
  Mic,
  ScanFace,
  Volume2,
  ChevronDown,
  Check,
  UserCheck,
} from "lucide-react";
import {
  BACKGROUND_EFFECT_OPTIONS,
  type BackgroundEffect,
} from "../lib/background-blur";

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface VideoSettingsProps {
  isMirrorCamera: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleMirror: () => void;
  backgroundEffect: BackgroundEffect;
  onBackgroundEffectChange: (effect: BackgroundEffect) => void;
  isCameraOff: boolean;
  isAdmin?: boolean;
  displayNameInput?: string;
  displayNameStatus?: { type: "success" | "error"; message: string } | null;
  isDisplayNameUpdating?: boolean;
  canUpdateDisplayName?: boolean;
  onDisplayNameInputChange?: (value: string) => void;
  onDisplayNameSubmit?: () => void;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
}

// Custom dropdown component
function DeviceDropdown({
  devices,
  selectedDeviceId,
  onSelect,
  placeholder,
}: {
  devices: MediaDeviceOption[];
  selectedDeviceId?: string;
  onSelect: (deviceId: string) => void;
  placeholder: string;
}) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedDevice = devices.find((d) => d.deviceId === selectedDeviceId);
  const displayLabel =
    selectedDevice?.label ||
    (devices.length > 0 ? devices[0].label : placeholder);

  useEffect(() => {
    if (!isDropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen]);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
        className="w-full flex items-center justify-between gap-1.5 bg-black/30 border border-[#FEFCD9]/10 rounded-md px-2 py-1.5 text-xs text-left transition-all hover:border-[#FEFCD9]/20"
      >
        <span className="truncate text-[#FEFCD9]/70">{displayLabel}</span>
        <ChevronDown
          className={`w-3 h-3 text-[#FEFCD9]/40 shrink-0 transition-transform ${
            isDropdownOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isDropdownOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-[#0d0e0d] border border-[#FEFCD9]/10 rounded-md max-h-32 overflow-y-auto z-50 shadow-xl">
          {devices.length === 0 ? (
            <div className="px-2 py-1.5 text-[10px] text-[#FEFCD9]/40">{placeholder}</div>
          ) : (
            devices.map((device) => (
              <button
                key={device.deviceId}
                onClick={() => {
                  onSelect(device.deviceId);
                  setIsDropdownOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left hover:bg-[#FEFCD9]/5 transition-colors"
              >
                <span className="truncate flex-1 text-[#FEFCD9]/70">
                  {device.label}
                </span>
                {(device.deviceId === selectedDeviceId ||
                  (!selectedDeviceId && device === devices[0])) && (
                  <Check className="w-3 h-3 text-[#F95F4A] shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function VideoSettings({
  isMirrorCamera,
  isOpen,
  onToggleOpen,
  onToggleMirror,
  backgroundEffect,
  onBackgroundEffectChange,
  isCameraOff,
  isAdmin,
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
}: VideoSettingsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [audioInputDevices, setAudioInputDevices] = useState<
    MediaDeviceOption[]
  >([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceOption[]
  >([]);
  const showDisplayNameSettings =
    !!isAdmin && !!onDisplayNameInputChange && !!onDisplayNameSubmit;

  // Fetch available devices
  const fetchDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const audioInputs = devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));

      const audioOutputs = devices
        .filter((d) => d.kind === "audiooutput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker ${i + 1}`,
        }));

      setAudioInputDevices(audioInputs);
      setAudioOutputDevices(audioOutputs);
    } catch (err) {
      console.error("[VideoSettings] Failed to enumerate devices:", err);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchDevices();
    }
  }, [isOpen, fetchDevices]);

  useEffect(() => {
    navigator.mediaDevices.addEventListener("devicechange", fetchDevices);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", fetchDevices);
    };
  }, [fetchDevices]);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onToggleOpen();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onToggleOpen]);

  return (
    <div ref={containerRef} className="relative" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
      <button
        onClick={onToggleOpen}
        className="w-8 h-8 rounded-full flex items-center justify-center text-[#FEFCD9]/70 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 transition-all"
        title="Settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 bg-[#0d0e0d]/95 backdrop-blur-md border border-[#FEFCD9]/10 rounded-lg p-2 w-72 z-50 shadow-2xl">
          {/* Mirror Camera Toggle */}
          <button
            onClick={onToggleMirror}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#FEFCD9]/5 rounded-lg text-xs transition-colors text-[#FEFCD9]"
          >
            <FlipHorizontal className="w-3.5 h-3.5" />
            <span>Mirror camera</span>
            <div className="ml-auto">
              <div
                className={`w-8 h-5 rounded-full transition-all relative ${
                  isMirrorCamera ? "bg-[#F95F4A]" : "bg-[#FEFCD9]/20"
                }`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#FEFCD9] transition-all ${
                    isMirrorCamera ? "left-3.5" : "left-0.5"
                  }`}
                />
              </div>
            </div>
          </button>

          <div className="px-3 py-2">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] text-[#FEFCD9]/40 uppercase tracking-wider">
              <ScanFace className="w-3 h-3" />
              <span>Camera filters</span>
            </div>
            <div className="space-y-1.5">
              {BACKGROUND_EFFECT_OPTIONS.map((option) => {
                const isSelected = backgroundEffect === option.id;
                return (
                  <button
                    key={option.id}
                    onClick={() => onBackgroundEffectChange(option.id)}
                    className={`w-full flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-[#F95F4A]/50 bg-[#F95F4A]/10 text-[#FEFCD9]"
                        : "border-[#FEFCD9]/10 text-[#FEFCD9]/75 hover:border-[#FEFCD9]/20 hover:bg-[#FEFCD9]/5"
                    }`}
                  >
                    <div className="flex-1">
                      <div className="text-xs">{option.label}</div>
                      <div className="text-[10px] text-[#FEFCD9]/45">
                        {option.description}
                      </div>
                    </div>
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-[#F95F4A]" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {showDisplayNameSettings && (
            <div className="px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] text-[#FEFCD9]/40 mb-1.5 uppercase tracking-wider">
                <UserCheck className="w-3 h-3" />
                <span>Display name</span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onDisplayNameSubmit?.();
                }}
                className="flex gap-1.5"
              >
                <input
                  type="text"
                  value={displayNameInput ?? ""}
                  onChange={(event) =>
                    onDisplayNameInputChange?.(event.target.value)
                  }
                  maxLength={40}
                  className="flex-1 px-2 py-1.5 bg-black/40 border border-[#FEFCD9]/15 rounded-md text-xs text-[#FEFCD9] focus:outline-none focus:border-[#F95F4A] transition-colors placeholder:text-[#FEFCD9]/30"
                  placeholder="Enter name"
                  disabled={isDisplayNameUpdating}
                />
                <button
                  type="submit"
                  disabled={!canUpdateDisplayName || isDisplayNameUpdating}
                  className="px-3 py-1.5 text-[10px] rounded-md bg-[#F95F4A] text-white disabled:opacity-50 transition-all"
                >
                  {isDisplayNameUpdating ? "..." : "Save"}
                </button>
              </form>
              {displayNameStatus && (
                <div
                  className={`mt-1 text-[10px] ${
                    displayNameStatus.type === "success"
                      ? "text-green-400"
                      : "text-[#F95F4A]"
                  }`}
                >
                  {displayNameStatus.message}
                </div>
              )}
            </div>
          )}

          <div className="border-t border-[#FEFCD9]/5 my-1" />

          {/* Microphone Selection */}
          <div className="px-3 py-2">
            <div 
              className="text-[10px] text-[#FEFCD9]/40 flex items-center gap-1.5 mb-1.5 uppercase tracking-wider"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <Mic className="w-3 h-3" />
              <span>Microphone</span>
            </div>
            <DeviceDropdown
              devices={audioInputDevices}
              selectedDeviceId={selectedAudioInputDeviceId}
              onSelect={(deviceId) => onAudioInputDeviceChange?.(deviceId)}
              placeholder="No microphones found"
            />
          </div>

          {/* Speaker Selection */}
          <div className="px-3 py-2">
            <div 
              className="text-[10px] text-[#FEFCD9]/40 flex items-center gap-1.5 mb-1.5 uppercase tracking-wider"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <Volume2 className="w-3 h-3" />
              <span>Speaker</span>
            </div>
            <DeviceDropdown
              devices={audioOutputDevices}
              selectedDeviceId={selectedAudioOutputDeviceId}
              onSelect={(deviceId) => onAudioOutputDeviceChange?.(deviceId)}
              placeholder="No speakers found"
            />
          </div>
        </div>
      )}
    </div>
  );
}
