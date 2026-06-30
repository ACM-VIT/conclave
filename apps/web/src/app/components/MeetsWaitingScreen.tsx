"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import ConclaveBrandScreen from "./ConclaveBrandScreen";

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
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!roomId) return;
    void navigator.clipboard
      ?.writeText(roomId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }, [roomId]);

  return (
    <ConclaveBrandScreen
      eyebrow="Waiting room"
      title={waitingTitle}
      detail={waitingIntro}
      actions={
        isAdmin && roomId ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#fafafa]/40">
              Room code
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 transition-colors duration-150 hover:bg-white/[0.08]"
            >
              <span className="text-[15px] font-medium text-[#F95F4A]">
                {roomId}
              </span>
              {copied ? (
                <Check size={15} strokeWidth={2} className="text-[#22c55e]" />
              ) : (
                <Copy size={15} strokeWidth={1.75} className="text-[#fafafa]/55" />
              )}
            </button>
          </div>
        ) : undefined
      }
    />
  );
}
