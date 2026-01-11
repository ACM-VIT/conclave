"use client";

import { memo } from "react";
import { MessageSquare, X } from "lucide-react";
import type { ChatMessage } from "../types";

interface ChatOverlayProps {
  messages: ChatMessage[];
  onDismiss: (id: string) => void;
}

function ChatOverlay({ messages, onDismiss }: ChatOverlayProps) {
  return (
    <div className="fixed bottom-24 left-4 z-40 flex flex-col gap-2 max-w-sm">
      {messages.slice(-3).map((message) => (
        <div
          key={message.id}
          className="bg-[#1f1f1f]/95 backdrop-blur-sm border border-white/10 rounded-lg shadow-lg p-3 animate-in slide-in-from-left-full duration-300"
        >
          <div className="flex items-start gap-2">
            <MessageSquare className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white/70 truncate">
                {message.displayName}
              </p>
              <p className="text-sm text-white break-words">
                {message.content}
              </p>
            </div>
            <button
              onClick={() => onDismiss(message.id)}
              className="p-0.5 text-white/30 hover:text-white/60 transition-colors shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(ChatOverlay);
