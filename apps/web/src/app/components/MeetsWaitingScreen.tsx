"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import ConclaveBrandScreen from "./ConclaveBrandScreen";

interface MeetsWaitingScreenProps {
  waitingMessage: string | null;
  roomId: string;
  isAdmin: boolean;
}

// The SFU's status line is matched by keyword for older clients (native
// classifies it the same way), so it is turned into Meet-style copy here.
export const describeWaitingRoom = (
  message: string | null,
): { title: string; detail: string } => {
  const lowered = message?.toLowerCase() ?? "";
  if (lowered.includes("meeting ended when everyone left")) {
    return {
      title: "This meeting has ended",
      detail: "Everyone left. Stay on this page and a host can let you in when it starts again.",
    };
  }
  if (lowered.includes("no one to let you in")) {
    return {
      title: "No one can let you in yet",
      detail: "You'll join as soon as a host is back and lets you in.",
    };
  }
  if (lowered.includes("host is available")) {
    return {
      title: "Asking to join…",
      detail: "A host is here now and can let you in.",
    };
  }
  return {
    title: "Asking to join…",
    detail: "You'll join the call when someone lets you in.",
  };
};

export default function MeetsWaitingScreen({
  waitingMessage,
  roomId,
  isAdmin,
}: MeetsWaitingScreenProps) {
  const { title, detail } = describeWaitingRoom(waitingMessage);
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
      title={title}
      detail={detail}
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
