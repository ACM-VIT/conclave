"use client";

import {
  Check,
  ChevronDown,
  ExternalLink,
  Image as ImageIcon,
  Lock,
  Paperclip,
  Reply,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import type { ConclaveAssistantApiKeyPromptState } from "../hooks/useMeetChat";
import type { ChatGifAttachment, ChatMessage, ChatReplyPreview } from "../lib/types";
import { getActionText, getCommandSuggestions } from "../lib/chat-commands";
import {
  CHAT_IMAGE_ACCEPT,
  CHAT_IMAGE_SIZE_MESSAGE,
  CHAT_IMAGE_TYPE_MESSAGE,
  MAX_CHAT_IMAGE_BYTES,
  chatImageCaption,
  formatChatImageSize,
  isSupportedChatImageType,
} from "../lib/chat-images";
import {
  type AssistantChatMessage,
  type AssistantToolApprovalDecision,
  type ConclaveAssistantModel,
  CONCLAVE_ASSISTANT_BYOK_MODELS,
  CONCLAVE_ASSISTANT_NAME,
  CONCLAVE_ASSISTANT_USER_ID,
  CONCLAVE_MENTION_TOKEN,
  isConclaveAssistantModel,
} from "../lib/conclave-assistant";
import { formatDisplayName, getChatMessageSegments } from "../lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import ChatGifAttachmentView from "./ChatGifAttachmentView";
import ChatImageAttachmentView from "./ChatImageAttachmentView";
import ConclaveMessage from "./ConclaveMessage";
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
  onSendImage: (
    file: File,
    caption: string,
    onProgress?: (progress: number) => void,
  ) => Promise<boolean>;
  onClose: () => void;
  currentUserId: string;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  areImageAttachmentsEnabled?: boolean;
  isAdmin?: boolean;
  assistantEnabled?: boolean;
  assistantApiKeyPrompt?: ConclaveAssistantApiKeyPromptState;
  onSubmitAssistantApiKey?: (
    apiKey: string,
    model: ConclaveAssistantModel,
  ) => void;
  onCancelAssistantApiKey?: () => void;
  onAssistantToolApproval?: (
    answerId: string,
    decision: AssistantToolApprovalDecision,
  ) => void;
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

function ChatPanel({
  messages,
  chatInput,
  onInputChange,
  onSend,
  onSendGif,
  onSendImage,
  onClose,
  currentUserId,
  isChatLocked = false,
  isDmEnabled = true,
  areImageAttachmentsEnabled = true,
  isAdmin = false,
  assistantEnabled = true,
  assistantApiKeyPrompt = {
    visible: false,
    error: null,
    model: "gpt-5.6-terra",
  },
  onSubmitAssistantApiKey,
  onCancelAssistantApiKey,
  onAssistantToolApproval,
  mentionableParticipants = [],
  replyTarget = null,
  onReply,
  onCancelReply,
}: ChatPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingImageUrlRef = useRef<string | null>(null);
  const sendAnimationTimeoutRef = useRef<number | null>(null);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);
  const messageNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const highlightTimeoutRef = useRef<number | null>(null);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isSendAnimating, setIsSendAnimating] = useState(false);
  const [pendingImage, setPendingImage] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);
  const [imageUploadProgress, setImageUploadProgress] = useState(0);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [assistantApiKeyInput, setAssistantApiKeyInput] = useState("");
  const [assistantModel, setAssistantModel] =
    useState<ConclaveAssistantModel>(assistantApiKeyPrompt.model);
  const [isAssistantModelMenuOpen, setIsAssistantModelMenuOpen] =
    useState(false);
  const assistantModelMenuRef = useRef<HTMLDivElement>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const isChatDisabled = isChatLocked && !isAdmin;
  const isImagePickerDisabled =
    isChatDisabled || !areImageAttachmentsEnabled || isImageUploading;
  const imagePickerLabel = areImageAttachmentsEnabled
    ? "Attach image"
    : "Image attachments disabled by host";
  const selectedAssistantModel =
    CONCLAVE_ASSISTANT_BYOK_MODELS.find(
      (model) => model.id === assistantModel,
    ) ?? CONCLAVE_ASSISTANT_BYOK_MODELS[0];

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

  // The "@Conclave" AI hint is independent of the DM/participant mention system
  // so it shows even when private messages are disabled. It tracks the "@handle"
  // the user is typing at the caret, anywhere in the message ("Hey @Con..."), not
  // just at the start, and disappears once the handle is complete with a space.
  const showConclaveSuggestion = useMemo(() => {
    if (!assistantEnabled || isChatDisabled || showCommandSuggestions) {
      return false;
    }
    const match = chatInput.match(/(?:^|\s)@([A-Za-z]*)$/);
    if (!match) return false;
    return CONCLAVE_MENTION_TOKEN.toLowerCase().startsWith(
      (match[1] ?? "").toLowerCase(),
    );
  }, [assistantEnabled, isChatDisabled, showCommandSuggestions, chatInput]);

  const applyConclaveSuggestion = useCallback(() => {
    // Replace just the "@handle" token being typed, preserving any text before
    // it ("Hey @Con" -> "Hey @Conclave ").
    const next = chatInput.replace(
      /((?:^|\s)@)[A-Za-z]*$/,
      `$1${CONCLAVE_MENTION_TOKEN} `,
    );
    onInputChange(next === chatInput ? `@${CONCLAVE_MENTION_TOKEN} ` : next);
    textareaRef.current?.focus();
  }, [chatInput, onInputChange]);

  const startConclavePrompt = useCallback(() => {
    onInputChange(`@${CONCLAVE_MENTION_TOKEN} `);
    textareaRef.current?.focus();
  }, [onInputChange]);

  const submitAssistantApiKey = useCallback(() => {
    onSubmitAssistantApiKey?.(assistantApiKeyInput, assistantModel);
    setAssistantApiKeyInput("");
  }, [assistantApiKeyInput, assistantModel, onSubmitAssistantApiKey]);

  const cancelAssistantApiKey = useCallback(() => {
    setAssistantApiKeyInput("");
    onCancelAssistantApiKey?.();
  }, [onCancelAssistantApiKey]);

  useEffect(() => {
    if (!assistantApiKeyPrompt.visible) {
      setAssistantApiKeyInput("");
      setIsAssistantModelMenuOpen(false);
    }
  }, [assistantApiKeyPrompt.visible]);

  useEffect(() => {
    setAssistantModel(assistantApiKeyPrompt.model);
  }, [assistantApiKeyPrompt.model, assistantApiKeyPrompt.visible]);

  useEffect(() => {
    if (!isAssistantModelMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        assistantModelMenuRef.current &&
        !assistantModelMenuRef.current.contains(event.target as Node)
      ) {
        setIsAssistantModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isAssistantModelMenuOpen]);

  useEffect(() => {
    setActiveCommandIndex(0);
    setActiveMentionIndex(0);
  }, [chatInput]);

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
    hasInitializedRef.current = true;
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
  }, [chatInput]);

  const clearPendingImage = useCallback(() => {
    if (pendingImageUrlRef.current) {
      URL.revokeObjectURL(pendingImageUrlRef.current);
      pendingImageUrlRef.current = null;
    }
    setPendingImage(null);
    setImageUploadProgress(0);
    setImageUploadError(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, []);

  useEffect(
    () => () => {
      if (pendingImageUrlRef.current) {
        URL.revokeObjectURL(pendingImageUrlRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!areImageAttachmentsEnabled && pendingImage && !isImageUploading) {
      clearPendingImage();
    }
  }, [
    areImageAttachmentsEnabled,
    clearPendingImage,
    isImageUploading,
    pendingImage,
  ]);

  const handleImageSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageUploadError(null);
    if (!isSupportedChatImageType(file.type)) {
      setImageUploadError(CHAT_IMAGE_TYPE_MESSAGE);
      event.target.value = "";
      return;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
      setImageUploadError(CHAT_IMAGE_SIZE_MESSAGE);
      event.target.value = "";
      return;
    }
    if (pendingImageUrlRef.current) {
      URL.revokeObjectURL(pendingImageUrlRef.current);
    }
    const previewUrl = URL.createObjectURL(file);
    pendingImageUrlRef.current = previewUrl;
    setPendingImage({ file, previewUrl });
    setImageUploadProgress(0);
    textareaRef.current?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isChatDisabled || isImageUploading) return;
    if (chatInput.trim() || pendingImage) {
      setIsSendAnimating(true);
      if (sendAnimationTimeoutRef.current !== null) {
        window.clearTimeout(sendAnimationTimeoutRef.current);
      }
      sendAnimationTimeoutRef.current = window.setTimeout(() => {
        setIsSendAnimating(false);
      }, 240);
      if (pendingImage) {
        setIsImageUploading(true);
        setImageUploadProgress(1);
        setImageUploadError(null);
        const sent = await onSendImage(
          pendingImage.file,
          chatInput.trim(),
          setImageUploadProgress,
        );
        setIsImageUploading(false);
        if (sent) {
          clearPendingImage();
          onInputChange("");
        } else {
          setImageUploadError("Couldn’t send this image. Try again.");
        }
        return;
      }
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

    if (showConclaveSuggestion && !showMentionSuggestions) {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyConclaveSuggestion();
        return;
      }
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
      void handleSubmit(e);
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

      {messages.length === 0 ? (
        <div className="web-chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
          {(() => {
                  const restricted = isChatLocked && !isAdmin
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
                  {/* Faded preview of a conversation, hinting at where messages land */}
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
                  {assistantEnabled && !isChatDisabled ? (
                    <div className="flex flex-col items-center gap-1.5">
                      <button
                        type="button"
                        onClick={startConclavePrompt}
                        className="inline-flex items-center gap-2 rounded-full border border-[#F95F4A]/30 bg-[#F95F4A]/[0.08] px-3 py-1.5 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:bg-[#F95F4A]/[0.14]"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#F95F4A] text-[10px] font-semibold text-white">
                          C
                        </span>
                        Ask Conclave AI anything
                      </button>
                      <p className="text-[11px] text-[#a1a1aa]/70">
                        Summon it with{" "}
                        <span className="font-medium text-[#a1a1aa]">
                          @{CONCLAVE_MENTION_TOKEN}
                        </span>{" "}
                        anywhere in a message.
                      </p>
                    </div>
                  ) : null}
                </div>
              );
          })()}
        </div>
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="gap-0 px-4 py-4">
            {messages.map((msg, index) => {
              const isOwn = msg.userId === currentUserId;
              const messageRenderKey = getMessageRenderKey(msg);
              const isNew =
                hasInitializedRef.current && newMessageIds.has(messageRenderKey);
              const displayName = formatDisplayName(msg.displayName || msg.userId);

              const assistantMsg = msg as AssistantChatMessage;
              if (
                assistantMsg.isAssistant ||
                msg.userId === CONCLAVE_ASSISTANT_USER_ID
              ) {
                return (
                  <ConclaveMessage
                    key={messageRenderKey}
                    message={assistantMsg}
                    isNew={isNew}
                    onToolApproval={onAssistantToolApproval}
                  />
                );
              }

              const actionText =
                msg.gif || msg.image ? null : getActionText(msg.content);
              const previousMessage = index > 0 ? messages[index - 1] : null;
              const previousActionText = previousMessage
                ? previousMessage.gif || previousMessage.image
                  ? null
                  : getActionText(previousMessage.content)
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
                      {msg.replyTo.hasGif || msg.replyTo.hasImage ? (
                        <ImageIcon
                          size={11}
                          strokeWidth={1.75}
                          className="shrink-0"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">
                        {msg.replyTo.hasGif
                          ? "GIF"
                          : msg.replyTo.hasImage
                            ? "Image"
                            : msg.replyTo.content}
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
                  className={`group flex min-w-0 max-w-full rounded-xl transition-colors duration-300 ${
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
                          msg.gif || msg.image
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
                          (msg.gif || msg.image) && !isOwn && !msg.isDirect
                            ? "ring-1 ring-white/10"
                            : ""
                        }`}
                      >
                        {nestedReplyQuote}
                        {msg.gif ? (
                          <ChatGifAttachmentView gif={msg.gif} />
                        ) : msg.image ? (
                          <ChatImageAttachmentView
                            image={msg.image}
                            caption={chatImageCaption(msg.content, msg.image)}
                          />
                        ) : (
                          <div
                            className={`px-3.5 py-2 text-[13.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap ${
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
            })}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="shrink-0 border-t border-white/10 px-3 py-3"
      >
        <div className="relative">
          {(showConclaveSuggestion || showMentionSuggestions) && (
            <div className="absolute bottom-full left-0 right-0 z-10 mb-2 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#232327] p-1">
              {showConclaveSuggestion && (
                <button
                  type="button"
                  onClick={applyConclaveSuggestion}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#F95F4A] text-[11px] font-semibold text-white">
                    C
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium text-[#fafafa]">
                      {CONCLAVE_ASSISTANT_NAME}
                    </span>
                    <span className="truncate text-[11px] text-[#a1a1aa]">
                      Ask the meeting AI · everyone sees the reply
                    </span>
                  </span>
                </button>
              )}
              {showMentionSuggestions &&
                mentionSuggestions.map((participant, index) => {
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
          {assistantApiKeyPrompt.visible && !isChatDisabled && (
            <div className="mb-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-semibold text-[#fafafa]">
                      Connect Conclave AI
                    </span>
                    <span className="block text-[11px] leading-snug text-[#a1a1aa]">
                      Your OpenAI key, used only this session.
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={cancelAssistantApiKey}
                  className="shrink-0 rounded-md p-1 text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                  aria-label="Dismiss Conclave AI key prompt"
                >
                  <X size={14} strokeWidth={1.8} />
                </button>
              </div>

              <div className="flex gap-2">
                <input
                  type="password"
                  value={assistantApiKeyInput}
                  onChange={(event) =>
                    setAssistantApiKeyInput(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitAssistantApiKey();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelAssistantApiKey();
                    }
                  }}
                  placeholder="sk-..."
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] text-[#fafafa] outline-none transition-colors placeholder:text-[#71717a] focus:border-[#F95F4A]/60"
                />
                <button
                  type="button"
                  onClick={submitAssistantApiKey}
                  disabled={!assistantApiKeyInput.trim()}
                  className="shrink-0 rounded-lg bg-[#F95F4A] px-3 py-1.5 text-[12px] font-semibold text-white transition-[background-color,opacity] hover:bg-[#ff725f] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Connect
                </button>
              </div>

              {/* Custom model picker so the closed state stays on-brand rather
                  than rendering a native browser <select>. */}
              <div ref={assistantModelMenuRef} className="relative mt-2">
                <button
                  type="button"
                  onClick={() => setIsAssistantModelMenuOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={isAssistantModelMenuOpen}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-left transition-colors hover:border-white/20"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[12.5px] font-medium text-[#fafafa]">
                      {selectedAssistantModel.label}
                    </span>
                    <span className="truncate text-[11px] text-[#a1a1aa]">
                      {selectedAssistantModel.description}
                    </span>
                  </span>
                  <ChevronDown
                    size={15}
                    strokeWidth={1.9}
                    className={`shrink-0 text-[#a1a1aa] transition-transform ${
                      isAssistantModelMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isAssistantModelMenuOpen && (
                  <div
                    role="listbox"
                    className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-[#232327] p-1 shadow-lg shadow-black/40"
                  >
                    {CONCLAVE_ASSISTANT_BYOK_MODELS.map((model) => {
                      const isSelected = model.id === assistantModel;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            if (isConclaveAssistantModel(model.id)) {
                              setAssistantModel(model.id);
                            }
                            setIsAssistantModelMenuOpen(false);
                          }}
                          className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            isSelected
                              ? "bg-white/[0.08]"
                              : "hover:bg-white/[0.04]"
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] font-medium text-[#fafafa]">
                              {model.label}
                            </span>
                            <span className="block text-[11px] leading-snug text-[#a1a1aa]">
                              {model.description}
                            </span>
                          </span>
                          {isSelected ? (
                            <Check
                              size={14}
                              strokeWidth={2}
                              className="mt-0.5 shrink-0 text-[#F95F4A]"
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {assistantApiKeyPrompt.error ? (
                <p className="mt-2 text-[11.5px] text-red-300">
                  {assistantApiKeyPrompt.error}
                </p>
              ) : (
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-[#a1a1aa]/70 transition-colors hover:text-[#a1a1aa]"
                >
                  Get a key
                  <ExternalLink size={11} strokeWidth={1.9} />
                </a>
              )}
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
                  {replyTarget.hasGif || replyTarget.hasImage ? (
                    <ImageIcon size={12} strokeWidth={1.75} className="shrink-0" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {replyTarget.hasGif
                      ? "GIF"
                      : replyTarget.hasImage
                        ? "Image"
                        : replyTarget.content}
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
          {pendingImage && !isChatDisabled ? (
            <div className="mb-2 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04]">
              <div className="flex items-center gap-3 p-2">
                <img
                  src={pendingImage.previewUrl}
                  alt="Selected attachment preview"
                  className="h-14 w-14 shrink-0 rounded-lg bg-black/30 object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-[#fafafa]">
                    {pendingImage.file.name}
                  </p>
                  <p role="status" className="mt-0.5 text-[11px] text-[#a1a1aa]">
                    {formatChatImageSize(pendingImage.file.size)}
                    {isImageUploading
                      ? ` · Uploading ${imageUploadProgress}%`
                      : " · Ready to send"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearPendingImage}
                  disabled={isImageUploading}
                  aria-label="Remove selected image"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
                >
                  <X size={15} strokeWidth={1.9} />
                </button>
              </div>
              {isImageUploading ? (
                <div className="h-0.5 bg-white/[0.06]">
                  <div
                    className="h-full bg-[#F95F4A] transition-[width] duration-150"
                    style={{ width: `${Math.max(2, imageUploadProgress)}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {imageUploadError ? (
            <p role="alert" className="mb-2 px-1 text-[11.5px] text-red-300">
              {imageUploadError}
            </p>
          ) : null}
          <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] py-2 pl-3 pr-2 transition-colors focus-within:border-white/20 focus-within:bg-white/[0.055]">
            <input
              ref={imageInputRef}
              type="file"
              accept={CHAT_IMAGE_ACCEPT}
              onChange={handleImageSelected}
              className="sr-only"
              tabIndex={-1}
            />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={isImagePickerDisabled}
              aria-label={imagePickerLabel}
              title={imagePickerLabel}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Paperclip size={17} strokeWidth={1.8} />
            </button>
            <GifPicker disabled={isChatDisabled} onSelect={handleSendGif} />
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isChatLocked && !isAdmin
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
              disabled={
                isChatDisabled ||
                isImageUploading ||
                (!chatInput.trim() && !pendingImage)
              }
              aria-label="Send message"
              title="Send message"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] text-white transition-[background-color,filter,opacity] hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-[#a1a1aa] disabled:brightness-100 ${
                isSendAnimating ? "web-chat-send-active" : ""
              }`}
            >
              <Send size={18} strokeWidth={1.75} />
            </button>
          </div>
          {!areImageAttachmentsEnabled && !isChatDisabled ? (
            <p className="mt-1.5 px-1 text-[11px] text-[#a1a1aa]">
              Image attachments are disabled by the host.
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export default ChatPanel;
