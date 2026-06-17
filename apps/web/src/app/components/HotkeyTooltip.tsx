"use client";

import { formatForDisplay } from "@tanstack/react-hotkeys";
import type { ReactNode } from "react";

interface HotkeyTooltipProps {
  label: string;
  hotkey: string;
  children: ReactNode;
}

export default function HotkeyTooltip({
  label,
  hotkey,
  children,
}: HotkeyTooltipProps) {
  // With no hotkey to surface, the tooltip would just duplicate the control's
  // own aria-label/title — so skip the hover chrome entirely.
  if (!hotkey) {
    return <>{children}</>;
  }
  return (
    <div className="relative group/tooltip">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 z-50 mb-1.5 flex flex-col items-center opacity-0 transition-opacity duration-150 group-hover/tooltip:opacity-100">
        <div className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#fafafa]/10 bg-[#131316]/95 px-2.5 py-1.5 backdrop-blur-sm">
          <span className="text-[11px] text-[#fafafa]/75">{label}</span>
          <kbd className="rounded border border-[#fafafa]/15 bg-[#fafafa]/[0.06] px-1.5 py-px text-[10px] text-[#fafafa]/75">
            {formatForDisplay(hotkey)}
          </kbd>
        </div>
        {/* downward arrow */}
        <div className="relative h-[7px] w-[14px] overflow-hidden">
          <div className="absolute left-1/2 top-0 h-[10px] w-[10px] -translate-x-1/2 rotate-45 border-b border-r border-[#fafafa]/10 bg-[#131316]/95" />
        </div>
      </div>
    </div>
  );
}
