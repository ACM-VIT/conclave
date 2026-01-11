"use client";

import { Send, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { formatDisplayName } from "../utils";

interface ChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
}

function ChatPanel({
  messages,
  chatInput,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode = false,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 64;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= threshold;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isGhostMode) return;
    if (chatInput.trim()) {
      onSend(chatInput);
      onInputChange("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div
      className="fixed right-4 top-16 bottom-20 w-72 bg-[#0d0e0d]/95 backdrop-blur-md border border-[#FEFCD9]/10 rounded-xl flex flex-col z-40 shadow-2xl"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#FEFCD9]/10">
        <span 
          className="text-[10px] uppercase tracking-[0.12em] text-[#FEFCD9]/60"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          Chat
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center text-[#FEFCD9]/50 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[#FEFCD9]/30 text-xs">
            No messages yet
          </div>
        ) : (
          messages.map((msg) => {
            const isOwn = msg.userId === currentUserId;
            const displayName = formatDisplayName(msg.displayName || msg.userId);
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
                    isOwn
                      ? "bg-[#F95F4A] text-white"
                      : "bg-[#1a1a1a] text-[#FEFCD9]/90"
                  }`}
                >
                  {!isOwn && (
                    <p className="text-[9px] text-[#F95F4A]/80 mb-0.5">{displayName}</p>
                  )}
                  <p className="text-xs break-words leading-relaxed">{msg.content}</p>
                </div>
                <span className="text-[9px] text-[#FEFCD9]/20 mt-0.5 tabular-nums">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="p-2 border-t border-[#FEFCD9]/5"
      >
        <div className="flex gap-1.5">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            maxLength={1000}
            disabled={isGhostMode}
            className="flex-1 px-2.5 py-1.5 bg-black/30 border border-[#FEFCD9]/10 rounded-md text-xs text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#FEFCD9]/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isGhostMode || !chatInput.trim()}
            className="w-8 h-8 rounded-md flex items-center justify-center text-[#FEFCD9]/60 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 disabled:opacity-30 transition-all"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        {isGhostMode && (
          <div className="mt-1.5 text-[9px] text-[#FF007A]/60 text-center">
            Ghost mode
          </div>
        )}
      </form>
    </div>
  );
}

export default memo(ChatPanel);
