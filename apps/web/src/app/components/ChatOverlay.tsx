"use client";

import { memo } from "react";
import { MessageSquare, X } from "lucide-react";
import type { ChatMessage } from "../lib/types";
import { getActionText } from "../lib/chat-commands";
import { formatDisplayName } from "../lib/utils";

interface ChatOverlayProps {
  messages: ChatMessage[];
  onDismiss: (id: string) => void;
}

function ChatOverlay({ messages, onDismiss }: ChatOverlayProps) {
  return (
    <div
      className="fixed bottom-24 left-4 z-40 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      {messages.slice(-3).map((message) => (
        <div
          key={message.id}
          className="animate-in slide-in-from-left-full fade-in rounded-xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 p-3 shadow-2xl backdrop-blur-md duration-300"
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
              <MessageSquare className="h-3.5 w-3.5 text-[#F95F4A]/90" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-[11px] text-[#FEFCD9]/55">
                {formatDisplayName(message.displayName || message.userId)}
              </p>
              {message.isDirect ? (
                <p className="text-[9px] uppercase tracking-[0.14em] text-amber-300/80">
                  Private message
                </p>
              ) : null}
              {(() => {
                const actionText = getActionText(message.content);
                if (!actionText) {
                  return (
                    <p className="break-words text-[15px] leading-snug text-[#FEFCD9]/95">
                      {message.content}
                    </p>
                  );
                }
                return (
                  <p className="break-words text-[13px] italic text-[#FEFCD9]/70">
                    {actionText}
                  </p>
                );
              })()}
            </div>
            <button
              onClick={() => onDismiss(message.id)}
              className="shrink-0 rounded text-[#FEFCD9]/45 transition-all hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
              aria-label={`Dismiss message from ${message.displayName}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(ChatOverlay);
