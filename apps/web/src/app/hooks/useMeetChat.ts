"use client";

import { useCallback, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { ChatGifAttachment, ChatMessage, ChatReplyPreview } from "../lib/types";
import {
  createLocalChatMessage,
  formatActionContent,
  getHelpText,
  normalizeChatMessage,
  parseChatCommand,
} from "../lib/chat-commands";

const DIRECT_MESSAGE_INTENT_PATTERN =
  /^(?:@\S+\s+[\s\S]+|\/dm\s+\S+\s+[\s\S]+)$/i;

type LocalRenderChatMessage = ChatMessage & {
  clientRenderKey?: string;
};

interface UseMeetChatOptions {
  socketRef: React.MutableRefObject<Socket | null>;
  ghostEnabled: boolean;
  currentUserId?: string;
  currentUserDisplayName?: string;
  isObserverMode?: boolean;
  isChatLocked?: boolean;
  isAdmin?: boolean;
  isDmEnabled?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
  onToggleMute?: () => void;
  onToggleCamera?: () => void;
  onSetHandRaised?: (raised: boolean) => void;
  onLeaveRoom?: () => void;
  onTtsMessage?: (payload: {
    userId: string;
    displayName: string;
    text: string;
  }) => void;
  isTtsDisabled?: boolean;
}

export function useMeetChat({
  socketRef,
  ghostEnabled,
  currentUserId = "local-user",
  currentUserDisplayName = "You",
  isObserverMode = false,
  isChatLocked = false,
  isAdmin = false,
  isDmEnabled = true,
  isMuted,
  isCameraOff,
  onToggleMute,
  onToggleCamera,
  onSetHandRaised,
  onLeaveRoom,
  onTtsMessage,
  isTtsDisabled,
}: UseMeetChatOptions) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOverlayMessages, setChatOverlayMessages] = useState<ChatMessage[]>(
    [],
  );
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatReplyPreview | null>(null);
  const isChatOpenRef = useRef(false);

  const appendLocalMessage = useCallback(
    (content: string) => {
      setChatMessages((prev) => [...prev, createLocalChatMessage(content)]);
    },
    [setChatMessages],
  );

  const buildOptimisticMessage = useCallback(
    (
      content: string,
      gif?: ChatGifAttachment,
      replyTo?: ChatReplyPreview,
    ): ChatMessage =>
      normalizeChatMessage({
        id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: currentUserId,
        displayName: currentUserDisplayName,
        content,
        timestamp: Date.now(),
        ...(gif ? { gif } : {}),
        ...(replyTo ? { replyTo } : {}),
      }).message,
    [currentUserDisplayName, currentUserId],
  );

  const startReply = useCallback((message: ChatMessage) => {
    setReplyTarget({
      id: message.id,
      userId: message.userId,
      displayName: message.displayName,
      content: message.gif ? message.gif.title || "GIF" : message.content,
      hasGif: Boolean(message.gif),
      isDirect: message.isDirect,
      dmTargetUserId: message.dmTargetUserId,
    });
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTarget(null);
  }, []);

  const clearChat = useCallback(() => {
    setChatMessages([]);
    setChatOverlayMessages([]);
    setUnreadCount(0);
    setReplyTarget(null);
  }, [setChatMessages, setChatOverlayMessages, setUnreadCount]);

  const sendChatInternal = useCallback(
    (content: string, gif?: ChatGifAttachment, replyTo?: ChatReplyPreview) => {
      const socket = socketRef.current;
      const trimmedContent = content.trim();
      if (!socket || (!trimmedContent && !gif)) return;

      const messageContent = trimmedContent || gif?.title || "GIF";
      const optimisticMessage = buildOptimisticMessage(
        messageContent,
        gif,
        replyTo,
      );
      setChatMessages((prev) => [...prev, optimisticMessage]);

      socket.emit(
        "sendChat",
        {
          content: messageContent,
          ...(gif ? { gif } : {}),
          ...(replyTo ? { replyTo } : {}),
        },
        (
          response:
            | { success: boolean; message?: ChatMessage }
            | { error: string },
        ) => {
          if ("error" in response) {
            console.error("[Meets] Chat error:", response.error);
            setChatMessages((prev) =>
              prev.filter((message) => message.id !== optimisticMessage.id),
            );
            appendLocalMessage(response.error);
            return;
          }
          if (response.message) {
            const { message, ttsText } = normalizeChatMessage(response.message);
            setChatMessages((prev) => {
              const optimisticIndex = prev.findIndex(
                (item) => item.id === optimisticMessage.id,
              );
              if (optimisticIndex === -1) {
                if (prev.some((item) => item.id === message.id)) {
                  return prev;
                }
                return [...prev, message];
              }
              const next = [...prev];
              const acknowledgedMessage: LocalRenderChatMessage = {
                ...message,
                clientRenderKey: optimisticMessage.id,
              };
              next[optimisticIndex] = acknowledgedMessage;
              return next;
            });
            if (ttsText && !isTtsDisabled) {
              onTtsMessage?.({
                userId: message.userId,
                displayName: message.displayName,
                text: ttsText,
              });
            }
            return;
          }
          setChatMessages((prev) =>
            prev.filter((message) => message.id !== optimisticMessage.id),
          );
        },
      );
    },
    [
      socketRef,
      onTtsMessage,
      isTtsDisabled,
      appendLocalMessage,
      buildOptimisticMessage,
    ],
  );

  const toggleChat = useCallback(() => {
    setIsChatOpen((prev) => {
      const newValue = !prev;
      isChatOpenRef.current = newValue;
      if (newValue) {
        setUnreadCount(0);
      }
      return newValue;
    });
  }, []);

  const sendChat = useCallback(
    (content: string) => {
      if (ghostEnabled || isObserverMode) return;
      if (isChatLocked && !isAdmin) {
        appendLocalMessage("Chat is locked by the host.");
        return;
      }
      const trimmed = content.trim();
      if (!trimmed) return;
      if (DIRECT_MESSAGE_INTENT_PATTERN.test(trimmed) && !isDmEnabled) {
        appendLocalMessage("Private messages are disabled by the host.");
        return;
      }

      const parsed = parseChatCommand(trimmed);
      if (parsed) {
        const { command, args } = parsed;
        if (command.id === "help") {
          appendLocalMessage(getHelpText());
          return;
        }
        if (command.id === "clear") {
          clearChat();
          return;
        }
        if (command.id === "tts") {
          if (isTtsDisabled) {
            appendLocalMessage("TTS is disabled by the host in this room.");
            return;
          }
          if (!args) {
            appendLocalMessage("Usage: /tts <text>");
            return;
          }
          sendChatInternal(`/tts ${args}`);
          return;
        }
        if (command.id === "me" || command.id === "action") {
          if (!args) return;
          sendChatInternal(formatActionContent(args));
          return;
        }
        if (command.id === "raise") {
          onSetHandRaised?.(true);
          return;
        }
        if (command.id === "lower") {
          onSetHandRaised?.(false);
          return;
        }
        if (command.id === "mute") {
          if (isMuted) {
            appendLocalMessage("You're already muted.");
          } else {
            onToggleMute?.();
          }
          return;
        }
        if (command.id === "unmute") {
          if (isMuted === false) {
            appendLocalMessage("You're already unmuted.");
          } else {
            onToggleMute?.();
          }
          return;
        }
        if (command.id === "camera") {
          const mode = args.toLowerCase();
          if (!mode || mode === "toggle") {
            onToggleCamera?.();
            return;
          }
          if (mode === "on") {
            if (isCameraOff === false) {
              appendLocalMessage("Camera is already on.");
            } else {
              onToggleCamera?.();
            }
            return;
          }
          if (mode === "off") {
            if (isCameraOff) {
              appendLocalMessage("Camera is already off.");
            } else {
              onToggleCamera?.();
            }
            return;
          }
          appendLocalMessage("Usage: /camera on|off|toggle");
          return;
        }
        if (command.id === "leave") {
          onLeaveRoom?.();
          return;
        }
      }

      const activeReply = replyTarget ?? undefined;
      if (activeReply) setReplyTarget(null);
      sendChatInternal(trimmed, undefined, activeReply);
    },
    [
      ghostEnabled,
      isObserverMode,
      isChatLocked,
      isAdmin,
      isDmEnabled,
      appendLocalMessage,
      clearChat,
      sendChatInternal,
      isMuted,
      isCameraOff,
      onToggleMute,
      onToggleCamera,
      onSetHandRaised,
      onLeaveRoom,
      isTtsDisabled,
      replyTarget,
    ],
  );

  const sendChatGif = useCallback(
    (gif: ChatGifAttachment) => {
      if (ghostEnabled || isObserverMode) return;
      if (isChatLocked && !isAdmin) {
        appendLocalMessage("Chat is locked by the host.");
        return;
      }
      const activeReply = replyTarget ?? undefined;
      if (activeReply) setReplyTarget(null);
      sendChatInternal(gif.title || "GIF", gif, activeReply);
    },
    [
      ghostEnabled,
      isObserverMode,
      isChatLocked,
      isAdmin,
      appendLocalMessage,
      sendChatInternal,
      replyTarget,
    ],
  );

  return {
    chatMessages,
    setChatMessages,
    chatOverlayMessages,
    setChatOverlayMessages,
    isChatOpen,
    unreadCount,
    setUnreadCount,
    chatInput,
    setChatInput,
    toggleChat,
    sendChat,
    sendChatGif,
    isChatOpenRef,
    replyTarget,
    startReply,
    cancelReply,
  };
}
