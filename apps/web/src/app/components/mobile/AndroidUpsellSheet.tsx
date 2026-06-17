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
          <div className="mobile-sheet-card border border-white/10 bg-[#161012] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#F95F4A]/25 bg-[#1a0f12]">
                <img
                  src="/logo.png"
                  alt="Conclave app logo"
                  className="h-8 w-8 object-contain"
                />
              </div>
              <div className="flex flex-col">
                <span className="text-base font-semibold text-[#fafafa]">
                  Conclave for Android
                </span>
                <span className="text-xs text-[#fafafa]/55">
                  Available on the Play Store
                </span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <a
                href="https://play.google.com/store/apps/details?id=com.acmvit.conclave"
                target="_blank"
                rel="noreferrer"
                className="flex h-12 w-full items-center justify-center rounded-xl bg-[#F95F4A] px-4 text-center text-sm font-medium text-white transition-colors hover:bg-[#e8553f]"
                style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              >
                Install Conclave
              </a>
              <button
                type="button"
                onClick={onClose}
                className="flex h-12 w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-[#fafafa]/80 hover:bg-white/10"
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
