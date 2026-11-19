"use client";

import { Sparkles, X } from "lucide-react";
import type { RoomAiController } from "../hooks/useRoomAi";
import RoomAiSettings from "./RoomAiSettings";

const ICON = 18;
const STROKE = 1.75;

export default function RoomAiPanel({
  controller,
  onClose,
}: {
  controller: RoomAiController;
  onClose: () => void;
}) {
  const status = !controller.connected ? "Reconnecting" : !controller.ready ? "Loading" : null;
  return (
    <aside
      aria-label="Room AI"
      className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full sm:w-[360px] flex-col overflow-hidden border-l border-white/10 bg-[#18181b] animate-panel-in"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={ICON} strokeWidth={STROKE} className="text-[#a1a1aa]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[#fafafa]">Room AI</h2>
            {status ? <p className="truncate text-[11.5px] text-[#a1a1aa]">{status}</p> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
          aria-label="Close Room AI"
        >
          <X size={ICON} strokeWidth={STROKE} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RoomAiSettings controller={controller} onClose={onClose} embedded />
      </div>
    </aside>
  );
}
