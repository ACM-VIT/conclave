"use client";

import { Send, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/types";
import { getActionText, getCommandSuggestions } from "../../lib/chat-commands";
import { getChatMessageSegments } from "../../lib/utils";

interface MobileChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
  isChatLocked?: boolean;
  isAdmin?: boolean;
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
  isChatLocked = false,
  isAdmin = false,
  getDisplayName,
}: MobileChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const commandSuggestions = getCommandSuggestions(chatInput);
  const showCommandSuggestions =
    !isChatDisabled && chatInput.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !chatInput.slice(1).includes(" ");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [chatInput]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && !isChatDisabled) {
      onSend(chatInput.trim());
      onInputChange("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showCommandSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveCommandIndex((prev) =>
          (prev + 1) % commandSuggestions.length
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveCommandIndex((prev) =>
          (prev - 1 + commandSuggestions.length) % commandSuggestions.length
        );
        return;
      }
      if (isPickingCommand && (e.key === "Tab" || e.key === "Enter")) {
        const command = commandSuggestions[activeCommandIndex];
        const isExactMatch =
          command &&
          chatInput.trim().toLowerCase() === `/${command.label}`;
        if (e.key === "Enter" && isExactMatch) {
          return;
        }
        e.preventDefault();
        if (command) {
          onInputChange(command.insertText);
        }
        return;
      }
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

  const renderMessageContent = (content: string) =>
    getChatMessageSegments(content).map((segment, index) =>
      segment.href ? (
        <a
          key={`${segment.href}-${index}`}
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-[#FEFCD9]/50 underline-offset-2 hover:decoration-[#FEFCD9]"
        >
          {segment.text}
        </a>
      ) : (
        <span key={`${segment.text}-${index}`}>{segment.text}</span>
      )
    );

  return (
    <div className="fixed inset-0 bg-[#1a1a1a] z-50 flex flex-col safe-area-pt safe-area-pb">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-[#FEFCD9]/10"
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        <h2 className="text-lg font-semibold text-[#FEFCD9] uppercase tracking-wide">Chat</h2>
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
            const actionText = getActionText(message.content);
            if (actionText) {
              return (
                <div
                  key={message.id}
                  className="text-[11px] text-[#FEFCD9]/70 italic px-1"
                >
                  <span className="text-[#F95F4A]/80">
                    {isOwn ? "You" : resolveDisplayName(message.userId)}
                  </span>{" "}
                  {actionText}
                </div>
              );
            }
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
                      ? "bg-[#F95F4A] text-white rounded-br-sm selection:bg-white/90 selection:text-[#0d0e0d]"
                      : "bg-[#2a2a2a] text-[#FEFCD9] rounded-bl-sm selection:bg-[#F95F4A]/40 selection:text-white"
                  }`}
                >
                  <p className="text-sm break-words">
                    {renderMessageContent(message.content)}
                  </p>
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
        className="relative flex items-center gap-2 px-4 py-3 border-t border-[#FEFCD9]/10 bg-[#1a1a1a]"
      >
        {showCommandSuggestions && (
          <div className="absolute bottom-full mb-2 left-0 right-0 max-h-40 overflow-y-auto rounded-2xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 shadow-xl">
            {commandSuggestions.map((command, index) => {
              const isActive = index === activeCommandIndex;
              return (
                <button
                  key={command.id}
                  type="button"
                  onClick={() => onInputChange(command.insertText)}
                  className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? "bg-[#F95F4A]/20 text-[#FEFCD9]"
                      : "text-[#FEFCD9]/70 hover:bg-[#FEFCD9]/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">/{command.label}</span>
                    <span className="text-[10px] text-[#FEFCD9]/40">
                      {command.usage}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#FEFCD9]/45">
                    {command.description}
                  </p>
                </button>
              );
            })}
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={chatInput}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isGhostMode
              ? "Ghost mode: chat disabled"
              : isChatLocked && !isAdmin
                ? "Chat locked by host"
                : "Type a message or /..."
          }
          disabled={isChatDisabled}
          className="flex-1 bg-[#2a2a2a] border border-[#FEFCD9]/10 rounded-full px-4 py-2.5 text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#F95F4A]/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!chatInput.trim() || isChatDisabled}
          className="w-10 h-10 rounded-full bg-[#F95F4A] text-white flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

export default memo(MobileChatPanel);
