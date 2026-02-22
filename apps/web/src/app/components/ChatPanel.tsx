"use client";

import { Send, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/types";
import { getActionText, getCommandSuggestions } from "../lib/chat-commands";
import { formatDisplayName, getChatMessageSegments } from "../lib/utils";

interface ChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
  isChatLocked?: boolean;
  isAdmin?: boolean;
}

function ChatPanel({
  messages,
  chatInput,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode = false,
  isChatLocked = false,
  isAdmin = false,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const commandSuggestions = getCommandSuggestions(chatInput);
  const showCommandSuggestions =
    !isChatDisabled && chatInput.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !chatInput.slice(1).includes(" ");

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [chatInput]);

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
    if (isChatDisabled) return;
    if (chatInput.trim()) {
      onSend(chatInput);
      onInputChange("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
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
            const actionText = getActionText(msg.content);
            if (actionText) {
              return (
                <div
                  key={msg.id}
                  className="text-[11px] text-[#FEFCD9]/70 italic px-1"
                >
                  <span className="text-[#F95F4A]/80">
                    {isOwn ? "You" : displayName}
                  </span>{" "}
                  {actionText}
                </div>
              );
            }
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
                    isOwn
                      ? "bg-[#F95F4A] text-white selection:bg-white/90 selection:text-[#0d0e0d]"
                      : "bg-[#1a1a1a] text-[#FEFCD9]/90 selection:bg-[#F95F4A]/40 selection:text-white"
                  }`}
                >
                  {!isOwn && (
                    <p className="text-[9px] text-[#F95F4A]/80 mb-0.5">{displayName}</p>
                  )}
                  <p className="text-xs break-words leading-relaxed">
                    {renderMessageContent(msg.content)}
                  </p>
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
        {showCommandSuggestions && (
          <div className="mb-1.5 max-h-40 overflow-y-auto rounded-md border border-[#FEFCD9]/10 bg-[#0d0e0d]/95">
            {commandSuggestions.map((command, index) => {
              const isActive = index === activeCommandIndex;
              return (
                <button
                  key={command.id}
                  type="button"
                  onClick={() => onInputChange(command.insertText)}
                  className={`w-full px-2.5 py-1.5 text-left text-xs transition-colors ${
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
        <div className="flex gap-1.5">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isGhostMode
                ? "Ghost mode: chat disabled"
                : isChatLocked && !isAdmin
                  ? "Chat locked by host"
                  : "Message... (type / for commands)"
            }
            maxLength={1000}
            disabled={isChatDisabled}
            className="flex-1 px-2.5 py-1.5 bg-black/30 border border-[#FEFCD9]/10 rounded-md text-xs text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#FEFCD9]/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isChatDisabled || !chatInput.trim()}
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
        {!isGhostMode && isChatLocked && !isAdmin && (
          <div className="mt-1.5 text-[9px] text-amber-200/70 text-center">
            Chat locked by host
          </div>
        )}
      </form>
    </div>
  );
}

export default memo(ChatPanel);
