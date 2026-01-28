
import { useCallback, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { ChatMessage } from "../types";
import {
  createLocalChatMessage,
  formatActionContent,
  getHelpText,
  normalizeChatMessage,
  parseChatCommand,
} from "../chat-commands";

interface UseMeetChatOptions {
  socketRef: React.MutableRefObject<Socket | null>;
  ghostEnabled: boolean;
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
}

export function useMeetChat({
  socketRef,
  ghostEnabled,
  isMuted,
  isCameraOff,
  onToggleMute,
  onToggleCamera,
  onSetHandRaised,
  onLeaveRoom,
  onTtsMessage,
}: UseMeetChatOptions) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOverlayMessages, setChatOverlayMessages] = useState<ChatMessage[]>(
    []
  );
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const isChatOpenRef = useRef(false);

  const appendLocalMessage = useCallback(
    (content: string) => {
      setChatMessages((prev) => [...prev, createLocalChatMessage(content)]);
    },
    [setChatMessages]
  );

  const clearChat = useCallback(() => {
    setChatMessages([]);
    setChatOverlayMessages([]);
    setUnreadCount(0);
  }, [setChatMessages, setChatOverlayMessages, setUnreadCount]);

  const sendChatInternal = useCallback(
    (content: string) => {
      const socket = socketRef.current;
      if (!socket || !content.trim()) return;

      socket.emit(
        "sendChat",
        { content: content.trim() },
        (
          response:
            | { success: boolean; message?: ChatMessage }
            | { error: string }
        ) => {
          if ("error" in response) {
            console.error("[Meets] Chat error:", response.error);
            return;
          }
          if (response.message) {
            const { message, ttsText } = normalizeChatMessage(response.message);
            setChatMessages((prev) => [...prev, message]);
            if (ttsText) {
              onTtsMessage?.({
                userId: message.userId,
                displayName: message.displayName,
                text: ttsText,
              });
            }
          }
        }
      );
    },
    [socketRef, onTtsMessage]
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
      if (ghostEnabled) return;
      const trimmed = content.trim();
      if (!trimmed) return;

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

      sendChatInternal(trimmed);
    },
    [
      ghostEnabled,
      appendLocalMessage,
      clearChat,
      sendChatInternal,
      isMuted,
      isCameraOff,
      onToggleMute,
      onToggleCamera,
      onSetHandRaised,
      onLeaveRoom,
    ]
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
    isChatOpenRef,
  };
}
