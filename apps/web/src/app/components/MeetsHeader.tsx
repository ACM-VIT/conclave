"use client";

import Image from "next/image";
import { CalendarClock } from "lucide-react";
import { memo } from "react";

interface MeetsHeaderProps {
  isJoined: boolean;
}

function MeetsHeader({ isJoined }: MeetsHeaderProps) {
  if (isJoined) {
    return null;
  }

  return (
    <header className="safe-area-pt fixed left-0 right-0 top-0 z-[100] pointer-events-none">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <a href="/" className="pointer-events-auto flex items-center" aria-label="Conclave home">
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM-VIT"
            width={128}
            height={128}
            className="h-auto w-[104px]"
            priority
          />
        </a>
        <a
          href="/schedule"
          className="pointer-events-auto inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 text-[12.5px] font-medium text-[#fafafa]/78 backdrop-blur transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
        >
          <CalendarClock className="h-4 w-4 text-[#F95F4A]" />
          Schedule
        </a>
      </div>
    </header>
  );
}

export default memo(MeetsHeader);
