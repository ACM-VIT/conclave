"use client";

import { Check, ScanFace, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  BACKGROUND_EFFECT_OPTIONS,
  type BackgroundEffect,
  createManagedCameraTrack,
  createManagedCameraTrackFromTrack,
  type ManagedCameraTrack,
} from "../lib/background-blur";

interface JoinCameraFiltersDrawerProps {
  isOpen: boolean;
  backgroundEffect: BackgroundEffect;
  onSelect: (effect: BackgroundEffect) => void;
  onClose: () => void;
  localStream?: MediaStream | null;
  isCameraOff?: boolean;
  isMirrorCamera?: boolean;
}

export default function JoinCameraFiltersDrawer({
  isOpen,
  backgroundEffect,
  onSelect,
  onClose,
  localStream,
  isCameraOff = false,
  isMirrorCamera = true,
}: JoinCameraFiltersDrawerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<ManagedCameraTrack | null>(null);
  const previewRequestIdRef = useRef(0);
  const [previewEffect, setPreviewEffect] =
    useState<BackgroundEffect>(backgroundEffect);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPreviewEffect(backgroundEffect);
    }
  }, [backgroundEffect, isOpen]);

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current;

    const releaseManagedPreview = () => {
      if (trackRef.current) {
        trackRef.current.stop();
        trackRef.current = null;
      }
    };

    async function updatePreview() {
      if (!isOpen) {
        releaseManagedPreview();
        setPreviewStream(null);
        setIsLoading(false);
        return;
      }

      const liveLocalVideoTrack = localStream?.getVideoTracks()[0];
      const canUseLiveLocalTrack =
        !isCameraOff && liveLocalVideoTrack?.readyState === "live";
      const canCloneLocalTrackForPreview =
        canUseLiveLocalTrack && backgroundEffect === "none";

      if (canUseLiveLocalTrack && previewEffect === backgroundEffect) {
        releaseManagedPreview();
        setPreviewStream(localStream ?? null);
        setIsLoading(false);
        return;
      }



      setIsLoading(true);
      releaseManagedPreview();

      try {
        const managedTrack = canCloneLocalTrackForPreview
          ? await createManagedCameraTrackFromTrack({
              effect: previewEffect,
              sourceTrack: liveLocalVideoTrack,
            })
          : await createManagedCameraTrack({
              effect: previewEffect,
              quality: "standard",
            });

        if (previewRequestIdRef.current === requestId) {
          trackRef.current = managedTrack;
          setPreviewStream(managedTrack.stream);
        } else {
          managedTrack.stop();
        }
      } catch (error) {
        if (previewRequestIdRef.current === requestId) {
          console.error("Failed to get preview stream:", error);
          setPreviewStream(null);
        }
      } finally {
        if (previewRequestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    }

    void updatePreview();

    return () => {
      if (previewRequestIdRef.current === requestId) {
        previewRequestIdRef.current += 1;
      }
      releaseManagedPreview();
    };
  }, [backgroundEffect, isCameraOff, isOpen, localStream, previewEffect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = previewStream;
    if (!previewStream) return;
    video.play().catch(() => {});
  }, [previewStream]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleApply = () => {
    onSelect(previewEffect);
    onClose();
  };

  return (
    <div
      className={`fixed inset-0 z-[140] flex items-center justify-center transition-opacity duration-200 ${
        isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      aria-hidden={!isOpen}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close filters"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      <div
        className={`relative z-10 flex w-full max-w-[420px] flex-col overflow-hidden rounded-[28px] border border-[#FEFCD9]/12 bg-[#090909]/96 shadow-[0_24px_80px_rgba(0,0,0,0.55)] transition-all duration-300 mx-4 max-h-[90vh] ${
          isOpen ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#FEFCD9]/10 px-5 py-4">
          <div>
            <div
              className="text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/40"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Camera Filters
            </div>
            <div className="mt-1 text-base text-[#FEFCD9]">Preview your look</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#FEFCD9]/60 transition-colors hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
            aria-label="Close filters"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Video Preview */}
        <div className="p-4">
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[20px] border border-[#FEFCD9]/10 bg-gradient-to-br from-[#151515] to-[#090909]">
            {previewStream ? (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={`h-full w-full object-cover ${
                  isMirrorCamera ? "scale-x-[-1]" : ""
                }`}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_top,_rgba(249,95,74,0.15),_transparent_60%),linear-gradient(180deg,_#151515,_#090909)]">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#FEFCD9]/15 bg-[#FEFCD9]/5">
                  <ScanFace
                    className={`h-7 w-7 text-[#FEFCD9]/50 ${
                      isLoading ? "animate-pulse" : ""
                    }`}
                  />
                </div>
                <div className="text-center">
                  <div className="text-sm text-[#FEFCD9]/80">
                    {isLoading ? "Starting preview..." : "Camera preview unavailable"}
                  </div>
                </div>
              </div>
            )}

            <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none">
              <div className="rounded-full border border-[#FEFCD9]/10 bg-black/60 px-4 py-1.5 backdrop-blur-md">
                <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#FEFCD9]/90">
                  {BACKGROUND_EFFECT_OPTIONS.find(
                    (option) => option.id === previewEffect,
                  )?.label ?? "Original"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Filter Options */}
        <div className="flex-1 overflow-y-auto border-t border-[#FEFCD9]/10 px-4 py-3">
          <div
            className="mb-3 px-1 text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/40"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Choose a filter
          </div>
          <div className="flex flex-col gap-2">
            {BACKGROUND_EFFECT_OPTIONS.map((option) => {
              const isSelected = option.id === previewEffect;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPreviewEffect(option.id)}
                  className={`group relative flex items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
                    isSelected
                      ? "border-[#F95F4A]/50 bg-[linear-gradient(135deg,rgba(249,95,74,0.18),rgba(255,0,122,0.08))] text-[#FEFCD9]"
                      : "border-[#FEFCD9]/10 bg-[#111111]/80 text-[#FEFCD9]/70 hover:border-[#FEFCD9]/20 hover:bg-[#171717]"
                  }`}
                >
                  <div
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
                      isSelected
                        ? "border-[#F95F4A]/40 bg-[#F95F4A]/15"
                        : "border-[#FEFCD9]/10 bg-[#FEFCD9]/5 group-hover:border-[#FEFCD9]/20 group-hover:bg-[#FEFCD9]/10"
                    }`}
                  >
                    <ScanFace
                      className={`h-5 w-5 ${
                        isSelected ? "text-[#F95F4A]" : "text-[#FEFCD9]/50"
                      }`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {option.label}
                      {option.experimental ? (
                        <span className="rounded-full bg-[#F95F4A]/20 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#F95F4A]">
                          Experimental
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#FEFCD9]/45">
                      {option.description}
                    </div>
                  </div>
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0 text-[#F95F4A]" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Apply Button */}
        <div className="border-t border-[#FEFCD9]/10 p-4">
          <button
            type="button"
            onClick={handleApply}
            className="w-full rounded-2xl bg-[#FEFCD9] px-4 py-3.5 text-sm font-semibold text-black transition-all hover:bg-white active:scale-[0.98]"
          >
            Apply Filter
          </button>
        </div>
      </div>
    </div>
  );
}
