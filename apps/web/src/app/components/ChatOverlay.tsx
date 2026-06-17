"use client";

import { memo } from "react";
import { Lock, MessageSquare, X } from "lucide-react";
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
          className="animate-in slide-in-from-left-full fade-in rounded-xl border border-[#fafafa]/10 bg-[#18181b]/95 p-3 backdrop-blur-md duration-300"
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#fafafa]/[0.06]">
              <MessageSquare
                size={14}
                strokeWidth={1.75}
                className="text-[#fafafa]/70"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-[12.5px] text-[#fafafa]/60">
                  {formatDisplayName(message.displayName || message.userId)}
                </p>
                {message.isDirect ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-[#fbbf24]">
                    <Lock size={12} strokeWidth={1.75} />
                    Private
                  </span>
                ) : null}
              </div>
              {(() => {
                const actionText = getActionText(message.content);
                if (!actionText) {
                  return (
                    <p className="mt-0.5 break-words text-[14px] leading-snug text-[#fafafa]">
                      {message.content}
                    </p>
                  );
                }
                return (
                  <p className="mt-0.5 break-words text-[13px] italic leading-snug text-[#fafafa]/80">
                    {actionText}
                  </p>
                );
              })()}
            </div>
            <button
              onClick={() => onDismiss(message.id)}
              className="shrink-0 rounded-md p-0.5 text-[#fafafa]/55 transition-colors hover:bg-[#fafafa]/[0.06] hover:text-[#fafafa]"
              aria-label={`Dismiss message from ${message.displayName}`}
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(ChatOverlay);
