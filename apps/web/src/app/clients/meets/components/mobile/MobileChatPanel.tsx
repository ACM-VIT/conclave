"use client";

import { Send, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { ChatMessage } from "../../types";

interface MobileChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
  getDisplayName?: (userId: string) => string;
}

function MobileChatPanel({
  messages,
  chatInput,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode = false,
  getDisplayName,
}: MobileChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && !isGhostMode) {
      onSend(chatInput.trim());
      onInputChange("");
    }
  };

  const resolveDisplayName = (userId: string) => {
    if (userId === currentUserId) return "You";
    if (getDisplayName) return getDisplayName(userId);
    return userId;
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="fixed inset-0 bg-[#1a1a1a] z-50 flex flex-col safe-area-pt safe-area-pb">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#FEFCD9]/10">
        <h2 className="text-lg font-semibold text-[#FEFCD9]">Chat</h2>
        <button
          onClick={onClose}
          className="p-2 rounded-full hover:bg-[#FEFCD9]/10 text-[#FEFCD9]/70"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <p className="text-[#FEFCD9]/40 text-sm text-center">
              No messages yet.
              <br />
              Start the conversation!
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const isOwn = message.userId === currentUserId;
            return (
              <div
                key={message.id}
                className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
              >
                {!isOwn && (
                  <span className="text-[10px] text-[#FEFCD9]/50 mb-0.5 px-1 uppercase tracking-wide">
                    {resolveDisplayName(message.userId)}
                  </span>
                )}
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                    isOwn
                      ? "bg-[#F95F4A] text-white rounded-br-sm"
                      : "bg-[#2a2a2a] text-[#FEFCD9] rounded-bl-sm"
                  }`}
                >
                  <p className="text-sm break-words">{message.content}</p>
                </div>
                <span className="text-[9px] text-[#FEFCD9]/30 mt-0.5 px-1">
                  {formatTime(message.timestamp)}
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
        className="flex items-center gap-2 px-4 py-3 border-t border-[#FEFCD9]/10 bg-[#1a1a1a]"
      >
        <input
          ref={inputRef}
          type="text"
          value={chatInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={isGhostMode ? "Ghost mode: chat disabled" : "Type a message..."}
          disabled={isGhostMode}
          className="flex-1 bg-[#2a2a2a] border border-[#FEFCD9]/10 rounded-full px-4 py-2.5 text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#F95F4A]/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!chatInput.trim() || isGhostMode}
          className="w-10 h-10 rounded-full bg-[#F95F4A] text-white flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

export default memo(MobileChatPanel);
