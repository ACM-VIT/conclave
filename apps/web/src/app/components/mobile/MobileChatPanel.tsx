"use client";

import { Send } from "lucide-react";
import { memo, useMemo, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/types";
import { getActionText, getCommandSuggestions } from "../../lib/chat-commands";
import { getChatMessageSegments } from "../../lib/utils";

interface MobileChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  isOpen: boolean;
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
  isOpen,
  currentUserId,
  isGhostMode = false,
  isChatLocked = false,
  isAdmin = false,
  getDisplayName,
}: MobileChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [localValue, setLocalValue] = useState(chatInput);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const commandSuggestions = getCommandSuggestions(localValue);
  const showCommandSuggestions =
    !isChatDisabled && localValue.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !localValue.slice(1).includes(" ");

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [messages.length]);

  useEffect(() => {
    if (chatInput !== localValue) {
      setLocalValue(chatInput);
    }
  }, [chatInput, localValue]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [localValue]);

  useEffect(() => {
    hasInitializedRef.current = true;
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (localValue.trim() && !isChatDisabled) {
      onSend(localValue.trim());
      setLocalValue("");
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
          localValue.trim().toLowerCase() === `/${command.label}`;
        if (e.key === "Enter" && isExactMatch) {
          return;
        }
        e.preventDefault();
        if (command) {
          setLocalValue(command.insertText);
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

  const newMessageIds = useMemo(() => {
    const prevIds = prevMessageIdsRef.current;
    const currentIds = new Set<string>();
    const newIds = new Set<string>();
    messages.forEach((message) => {
      currentIds.add(message.id);
      if (!prevIds.has(message.id)) {
        newIds.add(message.id);
      }
    });
    prevMessageIdsRef.current = currentIds;
    return newIds;
  }, [messages]);

  return (
    <div
      className="mobile-sheet-root z-50"
      data-state={isOpen ? "open" : "closed"}
      aria-hidden={!isOpen}
    >
      <div className="mobile-sheet-overlay" onClick={onClose} />
      <div className="mobile-sheet-panel">
        <div
          className="mobile-sheet w-full max-h-[92vh] h-[92vh] flex flex-col safe-area-pb"
          role="dialog"
          aria-modal="true"
          aria-label="Chat"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="px-4 pt-3 pb-2">
            <div className="mx-auto mobile-sheet-grabber" />
            <div
              className="mt-3 flex items-center justify-between"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <h2 className="text-base font-semibold text-[#FEFCD9] uppercase tracking-[0.2em]">
                Chat
              </h2>
              <button
                onClick={onClose}
                className="mobile-pill mobile-glass-soft px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]"
              >
                Done
              </button>
            </div>
          </div>

        <div className="flex-1 mobile-sheet-scroll overflow-y-auto px-4 pb-3 space-y-3">
          {messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center h-full py-6">
              <p className="text-[#FEFCD9]/45 text-sm text-center">
                No messages yet.
                <br />
                Start the conversation!
              </p>
            </div>
          ) : (
            messages.map((message) => {
              const isOwn = message.userId === currentUserId;
              const actionText = getActionText(message.content);
              const isNew =
                hasInitializedRef.current && newMessageIds.has(message.id);
              if (actionText) {
                return (
                  <div key={message.id} className={isNew ? "mobile-chat-message-new" : ""}>
                    <div className="text-[11px] text-[#FEFCD9]/70 italic px-1">
                      <span className="text-[#F95F4A]/80">
                        {isOwn ? "You" : resolveDisplayName(message.userId)}
                      </span>{" "}
                      {actionText}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={message.id}
                  className={`${isNew ? "mobile-chat-message-new" : ""} flex flex-col ${isOwn ? "items-end" : "items-start"}`}
                >
                  {!isOwn && (
                    <span className="text-[10px] text-[#FEFCD9]/50 mb-0.5 px-1 uppercase tracking-[0.18em]">
                      {resolveDisplayName(message.userId)}
                    </span>
                  )}
                  <div
                    className={`max-w-[80%] rounded-[18px] px-3 py-2 ${
                      isOwn
                        ? "bg-[#F95F4A] text-white rounded-br-md selection:bg-white/90 selection:text-[#0d0e0d]"
                        : "bg-[#2a2a2a]/90 text-[#FEFCD9] rounded-bl-md selection:bg-[#F95F4A]/40 selection:text-white"
                    }`}
                  >
                    <p className="text-sm break-words">
                      {renderMessageContent(message.content)}
                    </p>
                  </div>
                  <span className="text-[9px] text-[#FEFCD9]/35 mt-0.5 px-1">
                    {formatTime(message.timestamp)}
                  </span>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={handleSubmit}
          className="relative flex items-center gap-2 px-4 py-3 border-t border-[#FEFCD9]/10 bg-[#0b0b0b]/95"
        >
          {showCommandSuggestions && (
            <div className="absolute bottom-full mb-2 left-0 right-0 max-h-48 overflow-y-auto mobile-sheet-card shadow-xl overflow-hidden">
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
            value={localValue}
            onChange={(e) => {
              setLocalValue(e.target.value);
              onInputChange(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isGhostMode
                ? "Ghost mode: chat disabled"
                : isChatLocked && !isAdmin
                  ? "Chat locked by host"
                  : "Type a message or /..."
            }
            disabled={isChatDisabled}
            className="flex-1 mobile-glass mobile-pill px-4 py-2.5 text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#F95F4A]/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!localValue.trim() || isChatDisabled}
            className="w-10 h-10 rounded-full bg-[#F95F4A] text-white flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        </div>
      </div>
    </div>
  );
}

export default memo(MobileChatPanel);
