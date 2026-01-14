"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div className="min-h-dvh bg-[#0d0e0d] text-white flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="relative z-10 max-w-md w-full bg-[#1a1a1a]/90 border border-[#FEFCD9]/10 rounded-2xl p-6 shadow-2xl text-center">
        <div
          className="text-[11px] uppercase tracking-[0.3em] text-[#FEFCD9]/40"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          Something broke
        </div>
        <h1
          className="mt-4 text-2xl text-[#FEFCD9] tracking-tight"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          We hit a snag
        </h1>
        <p
          className="mt-3 text-sm text-[#FEFCD9]/60"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          Please try again. If this keeps happening, refresh the page or rejoin
          the room.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-[#F95F4A] text-white text-sm font-medium hover:bg-[#e8553f] transition-colors"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            Try Again
          </button>
          <a
            href="/"
            className="px-4 py-2 rounded-lg bg-white/10 text-[#FEFCD9] text-sm font-medium hover:bg-white/20 transition-colors"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            Go Home
          </a>
        </div>
      </div>
    </div>
  );
}
