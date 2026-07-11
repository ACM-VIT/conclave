"use client";

import { memo } from "react";
import { Lock, X } from "lucide-react";
import { Avatar } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";
import type { ChatMessage } from "../lib/types";
import { getActionText } from "../lib/chat-commands";
import { chatImageCaption } from "../lib/chat-images";
import { formatDisplayName } from "../lib/utils";
import ChatGifAttachmentView from "./ChatGifAttachmentView";
import ChatImageAttachmentView from "./ChatImageAttachmentView";

interface ChatOverlayProps {
  messages: ChatMessage[];
  onDismiss: (id: string) => void;
}

function ChatOverlay({ messages, onDismiss }: ChatOverlayProps) {
  return (
    <div className="fixed bottom-24 left-4 z-40 flex w-[21rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {messages.slice(-3).map((message) => {
        const displayName = formatDisplayName(message.displayName || message.userId);
        const actionText =
          message.gif || message.image ? null : getActionText(message.content);
        return (
          <div
            key={message.id}
            className="animate-in slide-in-from-left-full fade-in flex items-start gap-2.5 rounded-2xl border p-2.5 backdrop-blur-md duration-300"
            style={{
              backgroundColor: "rgba(24, 24, 27, 0.94)",
              borderColor: color.border,
            }}
          >
            <Avatar name={displayName} id={message.userId} size={30} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p
                  className="truncate text-[12.5px] font-medium"
                  style={{ color: color.text }}
                >
                  {displayName}
                </p>
                {message.isDirect ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium"
                    style={{ color: color.warning }}
                  >
                    <Lock size={11} strokeWidth={2} />
                    Private
                  </span>
                ) : null}
              </div>
              {actionText ? (
                <p
                  className="mt-0.5 [overflow-wrap:anywhere] text-[13px] italic leading-snug"
                  style={{ color: color.textMuted }}
                >
                  {actionText}
                </p>
              ) : message.gif ? (
                <ChatGifAttachmentView
                  gif={message.gif}
                  className="mt-2 rounded-xl"
                  widthClassName="w-[150px]"
                />
              ) : message.image ? (
                <ChatImageAttachmentView
                  image={message.image}
                  caption={chatImageCaption(message.content, message.image)}
                  expandable={false}
                  className="mt-2"
                  widthClassName="max-w-[180px]"
                />
              ) : (
                <p
                  className="mt-0.5 [overflow-wrap:anywhere] text-[13.5px] leading-snug"
                  style={{ color: color.text }}
                >
                  {message.content}
                </p>
              )}
            </div>
            <button
              onClick={() => onDismiss(message.id)}
              className="shrink-0 rounded-md p-1 transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08]"
              style={{ color: color.textFaint }}
              aria-label={`Dismiss message from ${displayName}`}
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default memo(ChatOverlay);
