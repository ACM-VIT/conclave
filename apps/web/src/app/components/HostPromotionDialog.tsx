"use client";

import { X } from "lucide-react";

interface HostPromotionDialogProps {
  isOpen: boolean;
  targetName: string;
  isSubmitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function HostPromotionDialog({
  isOpen,
  targetName,
  isSubmitting = false,
  onCancel,
  onConfirm,
}: HostPromotionDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-4 backdrop-blur-md animate-fade-in">
      <div
        className="relative w-full max-w-sm animate-scale-in"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        role="dialog"
        aria-modal="true"
        aria-label="Host promotion confirmation"
      >
        <div className="relative overflow-hidden rounded-2xl border border-[#FEFCD9]/12 bg-[#0d0e0d]/95 p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.28em] text-[#FEFCD9]/40">
                Host privileges
              </p>
              <h3 className="mt-1 text-[15px] font-medium text-[#FEFCD9]">
                Promote{" "}
                <span className="text-[#FEFCD9] break-words">{targetName}</span>
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-[#FEFCD9]/60">
                Grants immediate host controls (admit, mute, remove).
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-[#FEFCD9]/45 transition-colors hover:border-[#FEFCD9]/15 hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Close host promotion dialog"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="rounded-full border border-[#FEFCD9]/15 px-4 py-2 text-xs uppercase tracking-[0.18em] text-[#FEFCD9]/60 transition-all hover:border-[#FEFCD9]/35 hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isSubmitting}
              className="rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-[#FEFCD9] transition-all hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSubmitting ? "Promoting..." : "Add Host"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
