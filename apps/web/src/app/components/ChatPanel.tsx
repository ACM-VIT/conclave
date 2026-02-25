"use client";

import { Send, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../lib/types";
import { getActionText, getCommandSuggestions } from "../lib/chat-commands";
import { formatDisplayName, getChatMessageSegments } from "../lib/utils";

interface MentionableParticipant {
  userId: string;
  displayName: string;
  mentionToken: string;
}

type MentionInputMode = "at" | "dm";

interface ChatPanelProps {
  messages: ChatMessage[];
  chatInput: string;
  onInputChange: (value: string) => void;
  onSend: (content: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  isAdmin?: boolean;
  mentionableParticipants?: MentionableParticipant[];
}

const areMessagesEqual = (
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): boolean => {
  if (previousMessages === nextMessages) return true;
  if (previousMessages.length !== nextMessages.length) return false;

  for (let index = 0; index < previousMessages.length; index += 1) {
    const previousMessage = previousMessages[index];
    const nextMessage = nextMessages[index];
    if (previousMessage === nextMessage) continue;

    if (
      previousMessage.id !== nextMessage.id ||
      previousMessage.userId !== nextMessage.userId ||
      previousMessage.displayName !== nextMessage.displayName ||
      previousMessage.content !== nextMessage.content ||
      previousMessage.timestamp !== nextMessage.timestamp ||
      (previousMessage.isDirect ?? false) !== (nextMessage.isDirect ?? false) ||
      (previousMessage.dmTargetUserId ?? "") !==
        (nextMessage.dmTargetUserId ?? "") ||
      (previousMessage.dmTargetDisplayName ?? "") !==
        (nextMessage.dmTargetDisplayName ?? "")
    ) {
      return false;
    }
  }

  return true;
};

const areMentionableParticipantsEqual = (
  previousParticipants: MentionableParticipant[],
  nextParticipants: MentionableParticipant[],
): boolean => {
  if (previousParticipants === nextParticipants) return true;
  if (previousParticipants.length !== nextParticipants.length) return false;

  for (let index = 0; index < previousParticipants.length; index += 1) {
    const previousParticipant = previousParticipants[index];
    const nextParticipant = nextParticipants[index];
    if (previousParticipant === nextParticipant) continue;

    if (
      previousParticipant.userId !== nextParticipant.userId ||
      previousParticipant.displayName !== nextParticipant.displayName ||
      previousParticipant.mentionToken !== nextParticipant.mentionToken
    ) {
      return false;
    }
  }

  return true;
};

const areChatPanelPropsEqual = (
  previousProps: ChatPanelProps,
  nextProps: ChatPanelProps,
): boolean => {
  const previousIsGhostMode = previousProps.isGhostMode ?? false;
  const nextIsGhostMode = nextProps.isGhostMode ?? false;
  const previousIsChatLocked = previousProps.isChatLocked ?? false;
  const nextIsChatLocked = nextProps.isChatLocked ?? false;
  const previousIsDmEnabled = previousProps.isDmEnabled ?? true;
  const nextIsDmEnabled = nextProps.isDmEnabled ?? true;
  const previousIsAdmin = previousProps.isAdmin ?? false;
  const nextIsAdmin = nextProps.isAdmin ?? false;

  if (
    previousProps.chatInput !== nextProps.chatInput ||
    previousProps.currentUserId !== nextProps.currentUserId ||
    previousIsGhostMode !== nextIsGhostMode ||
    previousIsChatLocked !== nextIsChatLocked ||
    previousIsDmEnabled !== nextIsDmEnabled ||
    previousIsAdmin !== nextIsAdmin ||
    previousProps.onInputChange !== nextProps.onInputChange ||
    previousProps.onSend !== nextProps.onSend ||
    previousProps.onClose !== nextProps.onClose
  ) {
    return false;
  }

  if (!areMessagesEqual(previousProps.messages, nextProps.messages)) {
    return false;
  }

  return areMentionableParticipantsEqual(
    previousProps.mentionableParticipants ?? [],
    nextProps.mentionableParticipants ?? [],
  );
};

function ChatPanel({
  messages,
  chatInput,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode = false,
  isChatLocked = false,
  isDmEnabled = true,
  isAdmin = false,
  mentionableParticipants = [],
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const sendAnimationTimeoutRef = useRef<number | null>(null);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const previousMessageCountRef = useRef(messages.length);
  const hasInitializedRef = useRef(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isSendAnimating, setIsSendAnimating] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const commandSuggestions = getCommandSuggestions(chatInput);
  const showCommandSuggestions =
    !isChatDisabled && chatInput.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !chatInput.slice(1).includes(" ");

  const mentionContext = useMemo(() => {
    if (isChatDisabled || !isDmEnabled) return null;
    const value = chatInput.trimStart();

    if (value.startsWith("@")) {
      const raw = value.slice(1);
      if (/\s/.test(raw)) return null;
      return {
        mode: "at" as MentionInputMode,
        query: raw.toLowerCase(),
      };
    }

    const dmTargetMatch = value.match(/^\/dm\s*([^\s]*)$/i);
    if (!dmTargetMatch) return null;
    return {
      mode: "dm" as MentionInputMode,
      query: (dmTargetMatch[1] || "").toLowerCase(),
    };
  }, [chatInput, isChatDisabled, isDmEnabled]);
  const mentionMode = mentionContext?.mode ?? null;
  const mentionQuery = mentionContext?.query ?? null;

  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const normalizedMentionQuery = mentionQuery.replace(/[^a-z0-9._-]/g, "");
    return mentionableParticipants
      .filter((participant) => {
        if (!mentionQuery) return true;
        const displayNameMatch = participant.displayName
          .toLowerCase()
          .includes(mentionQuery);
        const mentionTokenMatch = participant.mentionToken
          .toLowerCase()
          .includes(normalizedMentionQuery);
        return displayNameMatch || mentionTokenMatch;
      })
      .sort((left, right) => {
        const leftStartsWith = left.mentionToken
          .toLowerCase()
          .startsWith(normalizedMentionQuery);
        const rightStartsWith = right.mentionToken
          .toLowerCase()
          .startsWith(normalizedMentionQuery);
        if (leftStartsWith !== rightStartsWith) {
          return leftStartsWith ? -1 : 1;
        }
        return left.displayName.localeCompare(right.displayName);
      });
  }, [mentionQuery, mentionableParticipants]);

  const showMentionSuggestions =
    !showCommandSuggestions && mentionQuery !== null && mentionSuggestions.length > 0;

  useEffect(() => {
    setActiveCommandIndex(0);
    setActiveMentionIndex(0);
  }, [chatInput]);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    const addedMessages = messages.length - previousCount;
    if (addedMessages > 0) {
      if (shouldAutoScrollRef.current) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
        setUnseenCount(0);
      } else {
        setUnseenCount((prev) => prev + addedMessages);
      }
    }
    previousMessageCountRef.current = messages.length;
  }, [messages]);

  useEffect(
    () => () => {
      if (sendAnimationTimeoutRef.current !== null) {
        window.clearTimeout(sendAnimationTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    hasInitializedRef.current = true;
  }, []);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 64;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceFromBottom <= threshold;
    shouldAutoScrollRef.current = isNearBottom;
    if (isNearBottom && unseenCount > 0) {
      setUnseenCount(0);
    }
  };

  const scrollToLatest = () => {
    shouldAutoScrollRef.current = true;
    setUnseenCount(0);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isChatDisabled) return;
    if (chatInput.trim()) {
      setIsSendAnimating(true);
      if (sendAnimationTimeoutRef.current !== null) {
        window.clearTimeout(sendAnimationTimeoutRef.current);
      }
      sendAnimationTimeoutRef.current = window.setTimeout(() => {
        setIsSendAnimating(false);
      }, 240);
      onSend(chatInput);
      onInputChange("");
    }
  };

  const applyMentionSuggestion = (index: number) => {
    const suggestion = mentionSuggestions[index];
    if (!suggestion || !mentionMode) return;
    const nextValue =
      mentionMode === "dm"
        ? `/dm ${suggestion.mentionToken} `
        : `@${suggestion.mentionToken} `;
    onInputChange(nextValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }

    if (showMentionSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveMentionIndex((prev) =>
          (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyMentionSuggestion(activeMentionIndex);
        return;
      }
    }

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
          className="break-all underline decoration-[#FEFCD9]/50 underline-offset-2 hover:decoration-[#FEFCD9]"
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
    const nextNewIds = new Set<string>();

    messages.forEach((message) => {
      currentIds.add(message.id);
      if (!prevIds.has(message.id)) {
        nextNewIds.add(message.id);
      }
    });

    prevMessageIdsRef.current = currentIds;
    return nextNewIds;
  }, [messages]);

  return (
    <div
      className="fixed right-4 top-16 bottom-20 w-72 bg-[#0d0e0d]/95 backdrop-blur-md border border-[#FEFCD9]/10 rounded-xl flex flex-col z-40 shadow-2xl"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-[#FEFCD9]/10">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] uppercase tracking-[0.12em] text-[#FEFCD9]/60"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Chat
          </span>
        </div>
        <button
          onClick={onClose}
          title="Close chat (Esc)"
          className="w-6 h-6 rounded flex items-center justify-center text-[#FEFCD9]/50 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="web-chat-scroll h-full min-h-0 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-1.5"
        >
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[#FEFCD9]/30 text-xs">
              No messages yet
            </div>
          ) : (
            messages.map((msg, index) => {
              const isOwn = msg.userId === currentUserId;
              const isNew =
                hasInitializedRef.current && newMessageIds.has(msg.id);
              const displayName = formatDisplayName(msg.displayName || msg.userId);
              const actionText = getActionText(msg.content);
              const previousMessage = index > 0 ? messages[index - 1] : null;
              const nextMessage =
                index < messages.length - 1 ? messages[index + 1] : null;
              const previousActionText = previousMessage
                ? getActionText(previousMessage.content)
                : null;
              const nextActionText = nextMessage
                ? getActionText(nextMessage.content)
                : null;
              const groupedWithPrevious = Boolean(
                previousMessage &&
                  !previousActionText &&
                  previousMessage.userId === msg.userId &&
                  previousMessage.isDirect === msg.isDirect &&
                  Math.abs(msg.timestamp - previousMessage.timestamp) < 120000
              );
              const groupedWithNext = Boolean(
                nextMessage &&
                  !nextActionText &&
                  nextMessage.userId === msg.userId &&
                  nextMessage.isDirect === msg.isDirect &&
                  Math.abs(nextMessage.timestamp - msg.timestamp) < 120000
              );
              const directMessageLabel = msg.isDirect
                ? isOwn
                  ? `Private to ${formatDisplayName(
                      msg.dmTargetDisplayName || msg.dmTargetUserId || "user"
                    )}`
                  : "Private message"
                : null;
              if (actionText) {
                return (
                  <div
                    key={msg.id}
                    className={`${isNew ? "web-chat-action-new" : ""} text-[11px] text-[#FEFCD9]/70 italic px-1 py-0.5`}
                  >
                    {directMessageLabel ? (
                      <p className="mb-0.5 text-[9px] not-italic uppercase tracking-[0.14em] text-amber-300/80">
                        {directMessageLabel}
                      </p>
                    ) : null}
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
                  className={`flex flex-col ${
                    isOwn ? "items-end" : "items-start"
                  } ${
                    isNew
                      ? isOwn
                        ? "web-chat-message-new-self"
                        : "web-chat-message-new-peer"
                      : ""
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-2.5 py-1.5 ${
                      isOwn
                        ? "bg-[#F95F4A] text-white selection:bg-white/90 selection:text-[#0d0e0d]"
                        : "bg-[#1a1a1a] text-[#FEFCD9]/90 selection:bg-[#F95F4A]/40 selection:text-white"
                    } ${
                      isOwn
                        ? groupedWithPrevious
                          ? "rounded-tr-md"
                          : ""
                        : groupedWithPrevious
                          ? "rounded-tl-md"
                          : ""
                    } ${msg.isDirect ? "ring-1 ring-amber-300/30" : ""}`}
                  >
                    {!isOwn && !groupedWithPrevious && (
                      <p className="text-[9px] text-[#F95F4A]/80 mb-0.5">{displayName}</p>
                    )}
                    {directMessageLabel ? (
                      <p className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-amber-300/80">
                        {directMessageLabel}
                      </p>
                    ) : null}
                    <p className="text-xs break-words leading-relaxed">
                      {renderMessageContent(msg.content)}
                    </p>
                  </div>
                  {!groupedWithNext && (
                    <span
                      className={`${isNew ? "web-chat-meta-new" : ""} text-[9px] text-[#FEFCD9]/20 mt-0.5 tabular-nums`}
                    >
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
        {unseenCount > 0 && (
          <button
            type="button"
            onClick={scrollToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[#FEFCD9]/20 bg-[#0d0e0d]/95 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/80 backdrop-blur-md shadow-lg hover:bg-[#151615] transition-colors"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            {unseenCount} new {unseenCount === 1 ? "message" : "messages"}
          </button>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 p-2 border-t border-[#FEFCD9]/5"
      >
        <div className="relative">
          {showMentionSuggestions && (
            <div className="absolute bottom-full mb-1.5 left-0 right-0 z-10 max-h-40 overflow-y-auto rounded-md border border-[#FEFCD9]/10 bg-[#0d0e0d]/95">
              {mentionSuggestions.map((participant, index) => {
                const isActive = index === activeMentionIndex;
                return (
                  <button
                    key={participant.userId}
                    type="button"
                    onClick={() => applyMentionSuggestion(index)}
                    className={`w-full px-2.5 py-1.5 text-left text-xs transition-colors ${
                      isActive
                        ? "bg-[#F95F4A]/20 text-[#FEFCD9]"
                        : "text-[#FEFCD9]/70 hover:bg-[#FEFCD9]/10"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{participant.displayName}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {showCommandSuggestions && (
            <div className="absolute bottom-full mb-1.5 left-0 right-0 z-10 max-h-40 overflow-y-auto rounded-md border border-[#FEFCD9]/10 bg-[#0d0e0d]/95">
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
              className={`w-8 h-8 rounded-md flex items-center justify-center text-[#FEFCD9]/60 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 disabled:opacity-30 transition-all ${
                isSendAnimating ? "web-chat-send-active" : ""
              }`}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
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

export default memo(ChatPanel, areChatPanelPropsEqual);
