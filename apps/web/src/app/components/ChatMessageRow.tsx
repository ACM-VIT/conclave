"use client";

import { AudioLines, Image as ImageIcon, Play, Square } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import ChatMessageActions from "./ChatMessageActions";
import ChatReactionChips from "./ChatReactionChips";
import ChatGifAttachmentView from "./ChatGifAttachmentView";
import ChatImageAttachmentView from "./ChatImageAttachmentView";
import ChatLinkEmbedView from "./ChatLinkEmbedView";
import ConclaveMessage from "./ConclaveMessage";
import { getActionText, getTtsMessageText } from "../lib/chat-commands";
import { chatImageCaption } from "../lib/chat-images";
import { canReactToChatMessage, toRenderableReactions } from "../lib/chat-reactions";
import {
  CONCLAVE_ASSISTANT_USER_ID,
  type AssistantChatMessage,
  type AssistantToolApprovalDecision,
} from "../lib/conclave-assistant";
import { replaceEmojiShortcodesInMessage } from "../lib/emoji-shortcodes";
import { extractEmbedUrls } from "../lib/link-embeds";
import type { ChatMessage } from "../lib/types";
import { formatDisplayName, getChatMessageSegments } from "../lib/utils";

const unknownReactorName = () => "Someone";

const renderMessageContent = (content: string, expandEmoji = true) =>
  getChatMessageSegments(
    expandEmoji ? replaceEmojiShortcodesInMessage(content) : content,
  ).map((segment, index) =>
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

function TtsEqualizer() {
  return (
    <span aria-hidden="true" className="flex h-3 items-center gap-[2.5px]">
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className="web-chat-tts-eq-bar h-full w-[2.5px] rounded-full bg-current"
        />
      ))}
    </span>
  );
}

function TtsMessageBody({
  message,
  isOwn,
  isSpeaking,
  onReplay,
  onStop,
  renderContent,
}: {
  message: ChatMessage;
  isOwn: boolean;
  isSpeaking: boolean;
  onReplay?: (message: ChatMessage) => void;
  onStop?: () => void;
  renderContent: (content: string) => ReactNode;
}) {
  const headerTone = isOwn ? "text-white/75" : "text-[#a1a1aa]";
  const controlTone = isOwn
    ? "bg-white/[0.16] text-white hover:bg-white/[0.26]"
    : "bg-white/[0.08] text-[#fafafa] hover:bg-white/[0.14]";
  const control = isSpeaking && onStop ? (
    <button
      type="button"
      onClick={onStop}
      aria-label="Stop speaking"
      title="Stop speaking"
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${controlTone}`}
    >
      <Square size={9} fill="currentColor" strokeWidth={0} />
    </button>
  ) : onReplay ? (
    <button
      type="button"
      onClick={() => onReplay(message)}
      aria-label="Play voice message"
      title="Play again (only you will hear it)"
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${controlTone}`}
    >
      <Play size={10} fill="currentColor" strokeWidth={0} className="translate-x-[0.5px]" />
    </button>
  ) : (
    <span
      aria-hidden="true"
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
        isOwn ? "bg-white/[0.16] text-white" : "bg-white/[0.08] text-[#fafafa]"
      }`}
    >
      <AudioLines size={12} strokeWidth={2} />
    </span>
  );

  return (
    <div className="px-3.5 pb-2 pt-2.5">
      <div className={`flex items-center gap-2 ${headerTone}`}>
        {control}
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em]">
          {isSpeaking ? "Speaking" : "Voice message"}
        </span>
        {isSpeaking ? <TtsEqualizer /> : null}
      </div>
      <div
        className={`mt-1.5 text-[13.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap ${
          isOwn
            ? "selection:bg-white/25 selection:text-white"
            : "selection:bg-[#F95F4A]/40 selection:text-white"
        }`}
      >
        {renderContent(getTtsMessageText(message.content))}
      </div>
    </div>
  );
}

type ChatMessageRowProps = {
  message: ChatMessage;
  previousMessage: ChatMessage | null;
  currentUserId: string;
  animateOnMount: boolean;
  isHighlighted: boolean;
  isSpeaking: boolean;
  onMessageNode: (id: string, node: HTMLDivElement | null) => void;
  scrollToMessage: (id: string) => void;
  onReply?: (message: ChatMessage) => void;
  onToggleReaction?: (id: string, emoji: string) => void;
  onViewReactions: (id: string) => void;
  resolveReactorName?: (id: string) => string;
  onReplayTtsMessage?: (message: ChatMessage) => void;
  onStopTts?: () => void;
  onAssistantToolApproval?: (
    answerId: string,
    decision: AssistantToolApprovalDecision,
  ) => void;
};

const ChatMessageRow = memo(function ChatMessageRow({
  message: msg,
  previousMessage,
  currentUserId,
  animateOnMount,
  isHighlighted,
  isSpeaking,
  onMessageNode,
  scrollToMessage,
  onReply,
  onToggleReaction,
  onViewReactions,
  resolveReactorName,
  onReplayTtsMessage,
  onStopTts,
  onAssistantToolApproval,
}: ChatMessageRowProps) {
  const isOwn = msg.userId === currentUserId;
  const displayName = formatDisplayName(msg.displayName || msg.userId);

  const assistantMsg = msg as AssistantChatMessage;
  if (
    assistantMsg.isAssistant ||
    msg.userId === CONCLAVE_ASSISTANT_USER_ID
  ) {
    return (
      <ConclaveMessage
        message={assistantMsg}
        isNew={animateOnMount}
        onToolApproval={onAssistantToolApproval}
      />
    );
  }

  const actionText =
    msg.gif || msg.image ? null : getActionText(msg.content);
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
        className={`${animateOnMount ? "web-chat-action-new" : ""} px-2 py-1.5 text-center text-[12px] leading-relaxed text-[#a1a1aa]`}
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

  const embedUrls =
    msg.gif || msg.image || msg.suppressEmbeds
      ? []
      : extractEmbedUrls(msg.content);

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

  const toggleReaction =
    onToggleReaction && canReactToChatMessage(msg)
      ? (emoji: string) => onToggleReaction(msg.id, emoji)
      : undefined;
  const renderableReactions = toRenderableReactions(
    msg.reactions,
    currentUserId,
  );

  return (
    <div
      ref={(node) => onMessageNode(msg.id, node)}
      className={`group flex min-w-0 max-w-full rounded-xl transition-colors duration-300 ${
        isOwn ? "justify-end" : "justify-start gap-3"
      } ${groupedWithPrevious ? "mt-1" : "mt-4 first:mt-0"} ${
        animateOnMount
          ? isOwn
            ? "web-chat-message-new-self"
            : "web-chat-message-new-peer"
          : ""
      } ${isHighlighted ? "web-chat-message-highlight" : ""}`}
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
          className={`relative flex max-w-full items-end gap-1.5 ${
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
            ) : msg.isTts ? (
              <TtsMessageBody
                message={msg}
                isOwn={isOwn}
                isSpeaking={isSpeaking}
                onReplay={onReplayTtsMessage}
                onStop={onStopTts}
                renderContent={(content) =>
                  // Spoken text is shown as typed, matching what
                  // the voice reads (shortcuts are not expanded).
                  renderMessageContent(content, false)
                }
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
          <ChatMessageActions
            isOwn={isOwn}
            reactions={renderableReactions}
            onToggleReaction={toggleReaction}
            onReply={onReply ? () => onReply(msg) : undefined}
            onViewReactions={
              renderableReactions.length > 0
                ? () => onViewReactions(msg.id)
                : undefined
            }
          />
        </div>
        <ChatReactionChips
          isOwn={isOwn}
          reactions={renderableReactions}
          currentUserId={currentUserId}
          resolveDisplayName={resolveReactorName ?? unknownReactorName}
          disabled={!toggleReaction}
          onToggle={toggleReaction}
        />
        {embedUrls.length > 0 ? (
          <div
            className={`mt-1 flex w-full min-w-0 flex-col gap-1 ${
              isOwn ? "items-end" : "items-start"
            }`}
          >
            {embedUrls.map((embedUrl) => (
              <ChatLinkEmbedView key={embedUrl} url={embedUrl} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default ChatMessageRow;
