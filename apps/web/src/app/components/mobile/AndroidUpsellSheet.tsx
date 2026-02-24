"use client";

import { memo } from "react";

interface AndroidUpsellSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

function AndroidUpsellSheet({ isOpen, onClose }: AndroidUpsellSheetProps) {
  return (
    <div
      className="mobile-sheet-root z-50"
      data-state={isOpen ? "open" : "closed"}
      aria-hidden={!isOpen}
    >
      <div className="mobile-sheet-overlay" onClick={onClose} />
      <div className="mobile-sheet-panel">
        <div
          className="mobile-sheet w-full max-h-[70vh] p-4 pb-6 safe-area-pb"
          role="dialog"
          aria-modal="true"
          aria-label="Install the Conclave app"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="relative px-1 pb-3">
            <div className="mx-auto mobile-sheet-grabber" />
          </div>
          <div className="mobile-sheet-card p-4 border border-white/10 bg-[#161012] shadow-[0_12px_28px_rgba(0,0,0,0.4)]">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-[#1a0f12] border border-[#F95F4A]/25 flex items-center justify-center shadow-[0_8px_18px_rgba(249,95,74,0.18)]">
                <img
                  src="/logo.png"
                  alt="Conclave app logo"
                  className="h-8 w-8 object-contain"
                />
              </div>
              <div className="flex flex-col">
                <span className="text-base font-semibold text-[#FEFCD9]">
                  Conclave for Android
                </span>
                <span className="text-xs text-[#FEFCD9]/55">
                  A better experience on mobile
                </span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <a
                href="https://play.google.com/store/apps/details?id=com.acmvit.conclave"
                target="_blank"
                rel="noreferrer"
                className="flex h-12 w-full items-center justify-center rounded-xl bg-[#F95F4A] px-4 text-center text-sm font-medium text-white transition-colors hover:bg-[#e8553f] shadow-[0_10px_24px_rgba(249,95,74,0.22)]"
                style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              >
                Install Conclave
              </a>
              <button
                type="button"
                onClick={onClose}
                className="flex h-12 w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-[#FEFCD9]/80 hover:bg-white/10"
                style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              >
                Continue in browser
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(AndroidUpsellSheet);
