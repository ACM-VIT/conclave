import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="min-h-dvh bg-[#0d0e0d] text-white flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="relative z-10 flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-[#F95F4A]/10 border border-[#F95F4A]/20 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-[#F95F4A] animate-spin" />
        </div>
        <div
          className="text-[11px] uppercase tracking-[0.3em] text-[#FEFCD9]/40"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          Loading
        </div>
      </div>
    </div>
  );
}
