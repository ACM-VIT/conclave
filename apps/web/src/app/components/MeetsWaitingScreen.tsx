"use client";

import Image from "next/image";

interface MeetsWaitingScreenProps {
  waitingTitle: string;
  waitingIntro: string;
  roomId: string;
  isAdmin: boolean;
}

export default function MeetsWaitingScreen({
  waitingTitle,
  waitingIntro,
  roomId,
  isAdmin,
}: MeetsWaitingScreenProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0b] text-[#fafafa]">
      <header className="flex items-center justify-between px-6 py-4">
        <a href="/" className="flex items-center">
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM Logo"
            width={100}
            height={100}
          />
        </a>
        <div className="flex flex-col items-end">
          <span 
            className="text-sm text-[#fafafa]"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            c0nclav3
          </span>
          <span 
            className="text-[9px] uppercase tracking-[0.15em] text-[#fafafa]/56"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            by acm-vit
          </span>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center text-center px-6">
          {/* Main branding */}
          <div className="mb-12">
            <div className="relative inline-block">
              <span 
                className="absolute -left-8 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-4xl"
                style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              >
                [
              </span>
              <h1 
                className="text-5xl md:text-6xl text-[#fafafa] tracking-tight"
                style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
              >
                c0nclav3
              </h1>
              <span 
                className="absolute -right-8 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-4xl"
                style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              >
                ]
              </span>
            </div>
          </div>

          {/* Divider line */}
          <div className="w-16 h-px bg-[#fafafa]/15 mb-8" />

          {/* Status */}
          <div 
            className="flex items-center gap-2 mb-3"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#F95F4A]" />
            <span className="text-[11px] text-[#fafafa]/75 uppercase tracking-[0.2em]">
              {waitingTitle}
            </span>
          </div>
          
          <p 
            className="text-[#fafafa]/30 text-sm max-w-xs"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            {waitingIntro}
          </p>

          {isAdmin && roomId && (
            <div 
              className="mt-8 px-4 py-2 border border-[#fafafa]/10 rounded"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <span className="text-[10px] text-[#fafafa]/30 uppercase tracking-wider">Room </span>
              <span className="text-sm text-[#F95F4A]">{roomId}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
