"use client";

import {
  ArrowDown,
  Ghost,
  Image as ImageIcon,
  Lock,
  Reply,
  Send,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import type { ChatGifAttachment, ChatMessage, ChatReplyPreview } from "../lib/types";
import { getActionText, getCommandSuggestions } from "../lib/chat-commands";
import { formatDisplayName, getChatMessageSegments } from "../lib/utils";
import ChatGifAttachmentView from "./ChatGifAttachmentView";
import GifPicker from "./GifPicker";

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
  onSendGif: (gif: ChatGifAttachment) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode?: boolean;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  isAdmin?: boolean;
  mentionableParticipants?: MentionableParticipant[];
  replyTarget?: ChatReplyPreview | null;
  onReply?: (message: ChatMessage) => void;
  onCancelReply?: () => void;
}

type LocalRenderChatMessage = ChatMessage & {
  clientRenderKey?: string;
};

const getMessageRenderKey = (message: ChatMessage): string =>
  (message as LocalRenderChatMessage).clientRenderKey ?? message.id;

const areGifsEqual = (
  previousGif?: ChatGifAttachment,
  nextGif?: ChatGifAttachment,
): boolean => {
  if (previousGif === nextGif) return true;
  if (!previousGif || !nextGif) return false;
  return (
    previousGif.id === nextGif.id &&
    previousGif.title === nextGif.title &&
    previousGif.url === nextGif.url &&
    (previousGif.previewUrl ?? "") === (nextGif.previewUrl ?? "") &&
    (previousGif.pageUrl ?? "") === (nextGif.pageUrl ?? "") &&
    (previousGif.width ?? 0) === (nextGif.width ?? 0) &&
    (previousGif.height ?? 0) === (nextGif.height ?? 0) &&
    previousGif.source === nextGif.source
  );
};

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
      !areGifsEqual(previousMessage.gif, nextMessage.gif) ||
      (previousMessage.isDirect ?? false) !== (nextMessage.isDirect ?? false) ||
      (previousMessage.dmTargetUserId ?? "") !==
        (nextMessage.dmTargetUserId ?? "") ||
      (previousMessage.dmTargetDisplayName ?? "") !==
        (nextMessage.dmTargetDisplayName ?? "") ||
      (previousMessage.replyTo?.id ?? "") !== (nextMessage.replyTo?.id ?? "")
    ) {
      return false;
    }
  }

  return true;
};

const areReplyTargetsEqual = (
  previous?: ChatReplyPreview | null,
  next?: ChatReplyPreview | null,
): boolean => {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.id === next.id &&
    previous.userId === next.userId &&
    previous.displayName === next.displayName &&
    previous.content === next.content &&
    Boolean(previous.hasGif) === Boolean(next.hasGif) &&
    Boolean(previous.isDirect) === Boolean(next.isDirect)
  );
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
    previousProps.onSendGif !== nextProps.onSendGif ||
    previousProps.onClose !== nextProps.onClose ||
    previousProps.onReply !== nextProps.onReply ||
    previousProps.onCancelReply !== nextProps.onCancelReply
  ) {
    return false;
  }

  if (!areMessagesEqual(previousProps.messages, nextProps.messages)) {
    return false;
  }

  if (
    !areReplyTargetsEqual(previousProps.replyTarget, nextProps.replyTarget)
  ) {
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
  onSendGif,
  onClose,
  currentUserId,
  isGhostMode = false,
  isChatLocked = false,
  isDmEnabled = true,
  isAdmin = false,
  mentionableParticipants = [],
  replyTarget = null,
  onReply,
  onCancelReply,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const sendAnimationTimeoutRef = useRef<number | null>(null);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const previousMessageCountRef = useRef(messages.length);
  const hasInitializedRef = useRef(false);
  const messageNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const highlightTimeoutRef = useRef<number | null>(null);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isSendAnimating, setIsSendAnimating] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const scrollToMessage = useCallback((id: string) => {
    const node = messageNodeRefs.current.get(id);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(id);
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedMessageId(null);
    }, 900);
  }, []);

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
        const frameId = window.requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
        setUnseenCount(0);
        previousMessageCountRef.current = messages.length;
        return () => window.cancelAnimationFrame(frameId);
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
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (replyTarget) {
      textareaRef.current?.focus();
    }
  }, [replyTarget]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      shouldAutoScrollRef.current = true;
      setUnseenCount(0);
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    hasInitializedRef.current = true;
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
  }, [chatInput]);

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

  const handleSendGif = (gif: ChatGifAttachment) => {
    if (isChatDisabled) return;
    onSendGif(gif);
    onInputChange("");
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
      if (replyTarget && onCancelReply) {
        onCancelReply();
        return;
      }
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
          className="break-all underline decoration-[#fafafa]/40 underline-offset-2 transition-[text-decoration-color] hover:decoration-[#fafafa]"
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
      const renderKey = getMessageRenderKey(message);
      currentIds.add(renderKey);
      if (!prevIds.has(renderKey)) {
        nextNewIds.add(renderKey);
      }
    });

    prevMessageIdsRef.current = currentIds;
    return nextNewIds;
  }, [messages]);

  return (
    <div
      className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full sm:w-[360px] flex-col border-l border-white/10 bg-[#18181b] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[#fafafa]">Chat</h2>
        <button
          onClick={onClose}
          aria-label="Close chat"
          title="Close chat (Esc)"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="web-chat-scroll h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4"
        >
          {messages.length === 0 ? (
            (() => {
                  const restricted = isGhostMode
                    ? {
                        icon: <Ghost size={20} strokeWidth={1.75} />,
                        title: "You're in ghost mode",
                        body: "Messages stay visible here, but sending and replying are disabled while you're invisible.",
                      }
                : isChatLocked && !isAdmin
                  ? {
                      icon: <Lock size={20} strokeWidth={1.75} />,
                      title: "Chat is locked",
                      body: "The host has paused messaging. You'll be able to chat when it reopens.",
                    }
                  : null;

              if (restricted) {
                return (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-[#a1a1aa]">
                      {restricted.icon}
                    </div>
                    <div className="max-w-[16rem] space-y-1.5">
                      <p className="text-[14px] font-semibold text-[#fafafa]">
                        {restricted.title}
                      </p>
                      <p className="text-[12.5px] leading-relaxed text-[#a1a1aa]">
                        {restricted.body}
                      </p>
                    </div>
                  </div>
                );
              }

              return (
                <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
                  {/* Ghosted preview of a conversation, hinting at where messages land */}
                  <div
                    aria-hidden="true"
                    className="flex w-full max-w-[14rem] flex-col gap-2 [mask-image:linear-gradient(to_bottom,transparent,#000_55%)]"
                  >
                    <div className="flex items-end gap-2">
                      <div className="h-6 w-6 shrink-0 rounded-full bg-white/[0.06]" />
                      <div className="h-7 w-32 rounded-[16px] rounded-bl-md bg-white/[0.05]" />
                    </div>
                    <div className="flex justify-end">
                      <div className="h-7 w-24 rounded-[16px] rounded-br-md bg-[#F95F4A]/25" />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="h-6 w-6 shrink-0 rounded-full bg-white/[0.06]" />
                      <div className="flex h-7 items-center gap-1 rounded-[16px] rounded-bl-md bg-white/[0.05] px-3">
                        <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
                        <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
                        <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
                      </div>
                    </div>
                  </div>
                  <div className="max-w-[15rem] space-y-1.5">
                    <p className="text-[14px] font-semibold text-[#fafafa]">
                      No messages yet
                    </p>
                    <p className="text-[12.5px] leading-relaxed text-[#a1a1aa]">
                      Be the first to say something. Drop a GIF, share a link, or
                      just say hi.
                    </p>
                  </div>
                </div>
              );
            })()
          ) : (
            messages.map((msg, index) => {
              const isOwn = msg.userId === currentUserId;
              const messageRenderKey = getMessageRenderKey(msg);
              const isNew =
                hasInitializedRef.current && newMessageIds.has(messageRenderKey);
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
                  !msg.replyTo &&
                  previousMessage.userId === msg.userId &&
                  (previousMessage.isDirect ?? false) ===
                    (msg.isDirect ?? false) &&
                  Math.abs(msg.timestamp - previousMessage.timestamp) < 120000
              );
              const groupedWithNext = Boolean(
                nextMessage &&
                  !nextActionText &&
                  !nextMessage.replyTo &&
                  nextMessage.userId === msg.userId &&
                  (nextMessage.isDirect ?? false) === (msg.isDirect ?? false) &&
                  Math.abs(nextMessage.timestamp - msg.timestamp) < 120000
              );
              const directMessageLabel = msg.isDirect
                ? isOwn
                  ? `Private to ${formatDisplayName(
                      msg.dmTargetDisplayName || msg.dmTargetUserId || "user"
                    )}`
                  : "Private message"
                : null;
              const timeLabel = new Date(msg.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });

              if (actionText) {
                return (
                  <div
                    key={messageRenderKey}
                    className={`${isNew ? "web-chat-action-new" : ""} px-2 py-1.5 text-center text-[12px] leading-relaxed text-[#a1a1aa]`}
                  >
                    {directMessageLabel ? (
                      <p className="mb-0.5 text-[11px] font-medium text-amber-300/80">
                        {directMessageLabel}
                      </p>
                    ) : null}
                    <span className="font-medium text-[#fafafa]">
                      {isOwn ? "You" : displayName}
                    </span>{" "}
                    <span>{actionText}</span>
                  </div>
                );
              }

              const replyAuthorLabel =
                msg.replyTo &&
                (msg.replyTo.userId === currentUserId
                  ? "You"
                  : formatDisplayName(msg.replyTo.displayName));

              const nestedReplyQuote = msg.replyTo ? (
                <button
                  type="button"
                  onClick={() => scrollToMessage(msg.replyTo!.id)}
                  className={`flex w-full items-center border-l-[3px] py-1.5 pl-2.5 pr-3 text-left transition-colors ${
                    isOwn
                      ? "border-white/70 bg-black/[0.14] hover:bg-black/[0.22]"
                      : "border-[#F95F4A] bg-black/20 hover:bg-black/30"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[11.5px] font-semibold ${
                        isOwn ? "text-white" : "text-[#F95F4A]"
                      }`}
                    >
                      {replyAuthorLabel}
                    </span>
                    <span
                      className={`flex min-w-0 items-center gap-1 truncate text-[12.5px] ${
                        isOwn ? "text-white/75" : "text-[#fafafa]/70"
                      }`}
                    >
                      {msg.replyTo.hasGif ? (
                        <ImageIcon
                          size={11}
                          strokeWidth={1.75}
                          className="shrink-0"
                        />
                      ) : null}
                      <span className="truncate">
                        {msg.replyTo.hasGif ? "GIF" : msg.replyTo.content}
                      </span>
                    </span>
                  </span>
                </button>
              ) : null;

              const replyButton = onReply && !isChatDisabled ? (
                <button
                  type="button"
                  onClick={() => onReply(msg)}
                  aria-label="Reply"
                  title="Reply"
                  className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#232327] text-[#a1a1aa] opacity-0 transition-[opacity,background-color,color] duration-100 hover:bg-[#2e2e33] hover:text-[#fafafa] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Reply size={13} strokeWidth={2} />
                </button>
              ) : null;

              return (
                <div
                  key={messageRenderKey}
                  ref={(el) => {
                    if (el) messageNodeRefs.current.set(msg.id, el);
                    else messageNodeRefs.current.delete(msg.id);
                  }}
                  className={`group flex rounded-xl transition-colors duration-300 ${
                    isOwn ? "justify-end" : "justify-start gap-3"
                  } ${groupedWithPrevious ? "mt-1" : "mt-4 first:mt-0"} ${
                    isNew
                      ? isOwn
                        ? "web-chat-message-new-self"
                        : "web-chat-message-new-peer"
                      : ""
                  } ${
                    highlightedMessageId === msg.id
                      ? "web-chat-message-highlight"
                      : ""
                  }`}
                >
                  {!isOwn ? (
                    <div className="w-9 shrink-0">
                      {!groupedWithPrevious ? (
                        <Avatar name={displayName} id={msg.userId} size={32} />
                      ) : null}
                    </div>
                  ) : null}

                  <div
                    className={`min-w-0 max-w-[84%] ${
                      isOwn ? "flex flex-col items-end" : "flex-1"
                    }`}
                  >
                    {!groupedWithPrevious && (
                      <div
                        className={`mb-1 flex max-w-full items-baseline gap-2 ${
                          isOwn ? "justify-end text-right" : ""
                        }`}
                      >
                        <span className="truncate text-[13px] font-medium text-[#fafafa]">
                          {isOwn ? "You" : displayName}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-[#a1a1aa]/70">
                          {timeLabel}
                        </span>
                      </div>
                    )}
                    {directMessageLabel ? (
                      <p
                        className={`mb-1 text-[11px] font-medium text-amber-300/80 ${
                          isOwn ? "text-right" : ""
                        }`}
                      >
                        {directMessageLabel}
                      </p>
                    ) : null}
                    <div
                      className={`flex items-end gap-1.5 ${
                        isOwn ? "flex-row-reverse" : ""
                      }`}
                    >
                      <div
                        className={`inline-block min-w-0 max-w-full overflow-hidden rounded-[18px] ${
                          msg.gif
                            ? "text-white"
                            : isOwn
                              ? "bg-[#F95F4A] text-white"
                              : "bg-white/[0.05] text-[#fafafa]"
                        } ${
                          isOwn && groupedWithPrevious ? "rounded-tr-md" : ""
                        } ${
                          !isOwn && groupedWithPrevious ? "rounded-tl-md" : ""
                        } ${
                          msg.isDirect ? "ring-1 ring-amber-300/30" : ""
                        } ${
                          msg.gif && !isOwn && !msg.isDirect
                            ? "ring-1 ring-white/10"
                            : ""
                        }`}
                      >
                        {nestedReplyQuote}
                        {msg.gif ? (
                          <ChatGifAttachmentView gif={msg.gif} />
                        ) : (
                          <div
                            className={`px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap ${
                              isOwn
                                ? "selection:bg-white/25 selection:text-white"
                                : "selection:bg-[#F95F4A]/40 selection:text-white"
                            }`}
                          >
                            {renderMessageContent(msg.content)}
                          </div>
                        )}
                      </div>
                      {replyButton}
                    </div>
                  </div>
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
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-[#232327] px-3 py-1.5 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:bg-[#2e2e33]"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <ArrowDown size={14} strokeWidth={1.75} />
            {unseenCount} new {unseenCount === 1 ? "message" : "messages"}
          </button>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="shrink-0 border-t border-white/10 px-3 py-3"
      >
        <div className="relative">
          {showMentionSuggestions && (
            <div className="absolute bottom-full left-0 right-0 z-10 mb-2 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#232327] p-1">
              {mentionSuggestions.map((participant, index) => {
                const isActive = index === activeMentionIndex;
                return (
                  <button
                    key={participant.userId}
                    type="button"
                    onClick={() => applyMentionSuggestion(index)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      isActive ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
                    }`}
                  >
                    <Avatar
                      name={participant.displayName}
                      id={participant.userId}
                      size={24}
                    />
                    <span className="truncate text-[13px] font-medium text-[#fafafa]">
                      {participant.displayName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {showCommandSuggestions && (
            <div className="absolute bottom-full left-0 right-0 z-10 mb-2 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#232327] p-1">
              {commandSuggestions.map((command, index) => {
                const isActive = index === activeCommandIndex;
                return (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => onInputChange(command.insertText)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                      isActive ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-[#fafafa]">
                        /{command.label}
                      </span>
                      <span className="shrink-0 text-[11px] text-[#a1a1aa]">
                        {command.usage}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] leading-snug text-[#a1a1aa]">
                      {command.description}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
          {replyTarget && !isChatDisabled && (
            <div className="mb-2 flex items-stretch gap-2.5 overflow-hidden rounded-xl bg-white/[0.04] pr-1.5">
              <span
                className="w-[3px] shrink-0 bg-[#F95F4A]"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 py-1.5">
                <p className="truncate text-[11.5px] text-[#a1a1aa]">
                  Replying to{" "}
                  <span className="font-semibold text-[#F95F4A]">
                    {replyTarget.userId === currentUserId
                      ? "yourself"
                      : formatDisplayName(replyTarget.displayName)}
                  </span>
                </p>
                <p className="flex min-w-0 items-center gap-1 truncate text-[12.5px] text-[#fafafa]/70">
                  {replyTarget.hasGif ? (
                    <ImageIcon size={12} strokeWidth={1.75} className="shrink-0" />
                  ) : null}
                  <span className="truncate">
                    {replyTarget.hasGif ? "GIF" : replyTarget.content}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={onCancelReply}
                aria-label="Cancel reply"
                title="Cancel reply"
                className="my-1.5 shrink-0 self-center rounded-md p-1 text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] py-2 pl-3 pr-2 transition-colors focus-within:border-white/20 focus-within:bg-white/[0.055]">
            <GifPicker disabled={isChatDisabled} onSelect={handleSendGif} />
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isGhostMode
                  ? "Ghost mode: watching chat"
                  : isChatLocked && !isAdmin
                    ? "Chat locked by host"
                    : "Send a message"
              }
              maxLength={1000}
              disabled={isChatDisabled}
              rows={1}
              className="max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-5 text-[#fafafa] placeholder:text-[#a1a1aa] focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isChatDisabled || !chatInput.trim()}
              aria-label="Send message"
              title="Send message"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] text-white transition-[background-color,filter,opacity] hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-[#a1a1aa] disabled:brightness-100 ${
                isSendAnimating ? "web-chat-send-active" : ""
              }`}
            >
              <Send size={18} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default memo(ChatPanel, areChatPanelPropsEqual);
