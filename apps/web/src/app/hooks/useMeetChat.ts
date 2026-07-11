"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { ChatGifAttachment, ChatMessage, ChatReplyPreview } from "../lib/types";
import {
  createLocalChatMessage,
  formatActionContent,
  getHelpText,
  normalizeChatMessage,
  parseChatCommand,
} from "../lib/chat-commands";
import {
  ConclaveAssistantApiKeyRequiredError,
  type AssistantChatMessage,
  type ConclaveAssistantModel,
  type ConclaveAssistantRelayPacket,
  type ConclaveAssistantHistoryItem,
  type AssistantToolApproval,
  type AssistantToolApprovalDecision,
  CONCLAVE_ASSISTANT_GLOBAL_MODEL,
  CONCLAVE_ASSISTANT_NAME,
  CONCLAVE_ASSISTANT_USER_ID,
  completeAssistantTasks,
  mergeAssistantTask,
  parseConclaveMention,
  streamConclaveAssistant,
} from "../lib/conclave-assistant";

export interface ConclaveAssistantContext {
  transcript: string;
  transcriptActive: boolean;
}

export interface ConclaveAssistantApiKeyPromptState {
  visible: boolean;
  error: string | null;
  model: ConclaveAssistantModel;
}

const DIRECT_MESSAGE_INTENT_PATTERN =
  /^(?:@\S+\s+[\s\S]+|\/dm\s+\S+\s+[\s\S]+)$/i;
const CONCLAVE_AUTHORIZATION_TIMEOUT_MS = 8000;

type LocalRenderChatMessage = ChatMessage & {
  clientRenderKey?: string;
};

interface PendingConclaveAssistantRequest {
  answerId: string;
  questionMessageId: string;
  question: string;
  history: ConclaveAssistantHistoryItem[];
  context: ConclaveAssistantContext;
}

interface UseMeetChatOptions {
  socketRef: React.MutableRefObject<Socket | null>;
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
    ttsVoiceToken?: string;
  }) => void;
  outgoingTtsVoiceToken?: string;
  isTtsDisabled?: boolean;
  assistantEnabled?: boolean;
  getAssistantContext?: () => ConclaveAssistantContext;
}

export function useMeetChat({
  socketRef,
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
  outgoingTtsVoiceToken,
  isTtsDisabled,
  assistantEnabled = true,
  getAssistantContext,
}: UseMeetChatOptions) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOverlayMessages, setChatOverlayMessages] = useState<ChatMessage[]>(
    [],
  );
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatReplyPreview | null>(null);
  const [assistantApiKeyPrompt, setAssistantApiKeyPrompt] =
    useState<ConclaveAssistantApiKeyPromptState>({
      visible: false,
      error: null,
      model: CONCLAVE_ASSISTANT_GLOBAL_MODEL,
    });
  const isChatOpenRef = useRef(false);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const assistantControllersRef = useRef<Set<AbortController>>(new Set());
  const assistantApiKeyRef = useRef("");
  const assistantModelRef = useRef<ConclaveAssistantModel>(
    CONCLAVE_ASSISTANT_GLOBAL_MODEL,
  );
  const pendingAssistantRequestRef =
    useRef<PendingConclaveAssistantRequest | null>(null);
  const pendingToolApprovalsRef = useRef<
    Map<
      string,
      {
        request: PendingConclaveAssistantRequest;
        approval: AssistantToolApproval;
      }
    >
  >(new Map());

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(
    () => () => {
      for (const controller of assistantControllersRef.current) {
        controller.abort();
      }
      assistantControllersRef.current.clear();
      pendingToolApprovalsRef.current.clear();
    },
    [],
  );

  const appendLocalMessage = useCallback(
    (content: string) => {
      setChatMessages((prev) => [...prev, createLocalChatMessage(content)]);
    },
    [setChatMessages],
  );

  const patchAssistantMessage = useCallback(
    (answerId: string, patch: Partial<AssistantChatMessage>) => {
      setChatMessages((prev) =>
        prev.map((message) =>
          message.id === answerId
            ? ({ ...(message as AssistantChatMessage), ...patch })
            : message,
        ),
      );
    },
    [setChatMessages],
  );

  const requestConclaveAuthorization = useCallback(
    (answerId: string, questionMessageId: string): Promise<{ token: string }> => {
      const socket = socketRef.current;
      if (!socket) {
        return Promise.reject(new Error("Conclave is not connected."));
      }

      return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          reject(new Error("Conclave authorization timed out."));
        }, CONCLAVE_AUTHORIZATION_TIMEOUT_MS);

        socket.emit(
          "conclave:authorize",
          {
            id: answerId,
            questionMessageId,
          },
          (response: { token?: string } | { error: string }) => {
            window.clearTimeout(timeoutId);
            if (!response || "error" in response) {
              reject(
                new Error(
                  response?.error || "Conclave could not authorize this answer.",
                ),
              );
              return;
            }
            if (!response.token) {
              reject(new Error("Conclave authorization response was empty."));
              return;
            }
            resolve({ token: response.token });
          },
        );
      });
    },
    [socketRef],
  );

  const relayConclavePacket = useCallback(
    (packet: ConclaveAssistantRelayPacket) => {
      socketRef.current?.emit("conclaveAnswer", packet);
    },
    [socketRef],
  );

  const startConclaveStream = useCallback(
    (
      request: PendingConclaveAssistantRequest,
      apiKey?: string,
      model?: ConclaveAssistantModel,
      githubIssueApproval?: {
        decision: AssistantToolApprovalDecision;
        approval: AssistantToolApproval;
      },
    ) => {
      const controller = new AbortController();
      assistantControllersRef.current.add(controller);
      patchAssistantMessage(
        request.answerId,
        githubIssueApproval
          ? {
              content: "",
              assistantStatus: "streaming",
              toolApproval: undefined,
            }
          : {
              content: "",
              assistantStatus: "streaming",
              reasoning: "",
              reasoningStatus: undefined,
              tasks: [],
              toolApproval: undefined,
            },
      );

      requestConclaveAuthorization(
        request.answerId,
        request.questionMessageId,
      )
        .then(({ token }) =>
          streamConclaveAssistant({
            answerId: request.answerId,
            question: request.question,
            relayToken: token,
            apiKey,
            model,
            history: request.history,
            transcript: request.context.transcript,
            transcriptActive: request.context.transcriptActive,
            signal: controller.signal,
            githubIssueApproval,
            onDelta: (fullText) => {
              if (controller.signal.aborted) return;
              patchAssistantMessage(request.answerId, { content: fullText });
            },
            onReasoning: (fullReasoning) => {
              if (controller.signal.aborted) return;
              patchAssistantMessage(request.answerId, {
                reasoning: fullReasoning,
                reasoningStatus: "streaming",
              });
            },
            onReasoningDone: () => {
              if (controller.signal.aborted) return;
              patchAssistantMessage(request.answerId, {
                reasoningStatus: "done",
              });
            },
            onTask: (task) => {
              if (controller.signal.aborted) return;
              setChatMessages((prev) =>
                prev.map((message) =>
                  message.id === request.answerId
                    ? {
                        ...(message as AssistantChatMessage),
                        tasks: mergeAssistantTask(
                          (message as AssistantChatMessage).tasks,
                          task,
                        ),
                      }
                    : message,
                ),
              );
            },
            onApproval: (approval) => {
              if (controller.signal.aborted) return;
              pendingToolApprovalsRef.current.set(request.answerId, {
                request,
                approval,
              });
              patchAssistantMessage(request.answerId, {
                assistantStatus: "approval_required",
                reasoningStatus: "done",
                toolApproval: approval,
              });
            },
            onRelay: (packet) => {
              if (controller.signal.aborted) return;
              relayConclavePacket(packet);
            },
            onDone: (finalText) => {
              if (controller.signal.aborted) return;
              patchAssistantMessage(request.answerId, {
                content: finalText.trim() || "I didn't catch anything to answer.",
                assistantStatus: "done",
                reasoningStatus: "done",
              });
              setChatMessages((prev) =>
                prev.map((message) =>
                  message.id === request.answerId
                    ? {
                        ...(message as AssistantChatMessage),
                        tasks: completeAssistantTasks(
                          (message as AssistantChatMessage).tasks,
                        ),
                      }
                    : message,
                ),
              );
            },
          }),
        )
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.status === "approval_required") return;
          patchAssistantMessage(request.answerId, {
            content:
              result.text.trim() || "I didn't catch anything to answer.",
            assistantStatus: "done",
            reasoningStatus: "done",
            toolApproval: undefined,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (error instanceof ConclaveAssistantApiKeyRequiredError) {
            pendingAssistantRequestRef.current = request;
            setAssistantApiKeyPrompt({
              visible: true,
              error: null,
              model: assistantModelRef.current,
            });
            patchAssistantMessage(request.answerId, {
              content:
                "Enter an OpenAI API key below to use Conclave AI in this room.",
              assistantStatus: "error",
            });
            return;
          }
          patchAssistantMessage(request.answerId, {
            content:
              error instanceof Error
                ? error.message
                : "Conclave could not answer right now.",
            assistantStatus: "error",
            toolApproval: undefined,
          });
        })
        .finally(() => {
          assistantControllersRef.current.delete(controller);
        });
    },
    [
      patchAssistantMessage,
      relayConclavePacket,
      requestConclaveAuthorization,
      setChatMessages,
    ],
  );

  const resolveAssistantToolApproval = useCallback(
    (answerId: string, decision: AssistantToolApprovalDecision) => {
      const pending = pendingToolApprovalsRef.current.get(answerId);
      if (!pending) return;
      pendingToolApprovalsRef.current.delete(answerId);
      startConclaveStream(
        pending.request,
        assistantApiKeyRef.current || undefined,
        assistantApiKeyRef.current ? assistantModelRef.current : undefined,
        { decision, approval: pending.approval },
      );
    },
    [startConclaveStream],
  );

  // "@Conclave …" summons the room AI. The question is first accepted as a
  // public chat line, then the SFU issues a short-lived token for the answer.
  const askConclave = useCallback(
    (rawQuestion: string, questionMessageId: string) => {
      if (!assistantEnabled) {
        appendLocalMessage("Conclave AI isn't available in this room.");
        return;
      }

      const question =
        rawQuestion.trim() ||
        "Introduce yourself and briefly tell me what you can help with in this meeting.";

      const history: ConclaveAssistantHistoryItem[] = chatMessagesRef.current
        .filter((message) => message.userId !== "system" && !message.gif)
        .map((message) => ({
          name: message.displayName,
          isAssistant:
            (message as AssistantChatMessage).isAssistant === true ||
            message.userId === CONCLAVE_ASSISTANT_USER_ID,
          content: message.content,
        }));

      const answerId = `conclave-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const answerMessage: AssistantChatMessage = {
        id: answerId,
        userId: CONCLAVE_ASSISTANT_USER_ID,
        displayName: CONCLAVE_ASSISTANT_NAME,
        content: "",
        timestamp: Date.now(),
        isAssistant: true,
        assistantStatus: "streaming",
      };
      setChatMessages((prev) => [...prev, answerMessage]);

      const request: PendingConclaveAssistantRequest = {
        answerId,
        questionMessageId,
        question,
        history,
        context: getAssistantContext?.() ?? {
          transcript: "",
          transcriptActive: false,
        },
      };
      startConclaveStream(
        request,
        assistantApiKeyRef.current || undefined,
        assistantApiKeyRef.current ? assistantModelRef.current : undefined,
      );
    },
    [
      assistantEnabled,
      appendLocalMessage,
      getAssistantContext,
      setChatMessages,
      startConclaveStream,
    ],
  );

  const submitAssistantApiKey = useCallback(
    (apiKey: string, model: ConclaveAssistantModel) => {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        setAssistantApiKeyPrompt({
          visible: true,
          error: "Enter an OpenAI API key.",
          model,
        });
        return;
      }
      assistantApiKeyRef.current = trimmed;
      assistantModelRef.current = model;
      const pendingRequest = pendingAssistantRequestRef.current;
      pendingAssistantRequestRef.current = null;
      setAssistantApiKeyPrompt({ visible: false, error: null, model });
      if (pendingRequest) {
        startConclaveStream(pendingRequest, trimmed, model);
      }
    },
    [startConclaveStream],
  );

  const cancelAssistantApiKeyPrompt = useCallback(() => {
    pendingAssistantRequestRef.current = null;
    setAssistantApiKeyPrompt({
      visible: false,
      error: null,
      model: assistantModelRef.current,
    });
  }, []);

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
    (
      content: string,
      gif?: ChatGifAttachment,
      replyTo?: ChatReplyPreview,
    ): Promise<ChatMessage | null> => {
      const socket = socketRef.current;
      const trimmedContent = content.trim();
      if (!socket || (!trimmedContent && !gif)) {
        return Promise.resolve(null);
      }

      const messageContent = trimmedContent || gif?.title || "GIF";
      const isTtsMessage = /^\/tts(?:\s|$)/i.test(messageContent);
      const optimisticMessage = buildOptimisticMessage(
        messageContent,
        gif,
        replyTo,
      );
      setChatMessages((prev) => [...prev, optimisticMessage]);

      return new Promise((resolve) => {
        socket.emit(
          "sendChat",
          {
            content: messageContent,
            ...(gif ? { gif } : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(isTtsMessage && outgoingTtsVoiceToken
              ? { ttsVoiceToken: outgoingTtsVoiceToken }
              : {}),
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
              resolve(null);
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
                  ttsVoiceToken: message.ttsVoiceToken,
                });
              }
              resolve(message);
              return;
            }
            setChatMessages((prev) =>
              prev.filter((message) => message.id !== optimisticMessage.id),
            );
            resolve(null);
          },
        );
      });
    },
    [
      socketRef,
      onTtsMessage,
      isTtsDisabled,
      appendLocalMessage,
      buildOptimisticMessage,
      outgoingTtsVoiceToken,
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
      if (isObserverMode) return;
      if (isChatLocked && !isAdmin) {
        appendLocalMessage("Chat is locked by the host.");
        return;
      }
      const trimmed = content.trim();
      if (!trimmed) return;

      const conclaveQuestion = parseConclaveMention(trimmed);
      if (conclaveQuestion !== null) {
        void sendChatInternal(trimmed).then((message) => {
          if (message) {
            askConclave(conclaveQuestion, message.id);
          }
        });
        return;
      }

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
          void sendChatInternal(`/tts ${args}`);
          return;
        }
        if (command.id === "me" || command.id === "action") {
          if (!args) return;
          void sendChatInternal(formatActionContent(args));
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
      void sendChatInternal(trimmed, undefined, activeReply);
    },
    [
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
      askConclave,
    ],
  );

  const sendChatGif = useCallback(
    (gif: ChatGifAttachment) => {
      if (isObserverMode) return;
      if (isChatLocked && !isAdmin) {
        appendLocalMessage("Chat is locked by the host.");
        return;
      }
      const activeReply = replyTarget ?? undefined;
      if (activeReply) setReplyTarget(null);
      void sendChatInternal(gif.title || "GIF", gif, activeReply);
    },
    [
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
    assistantApiKeyPrompt,
    submitAssistantApiKey,
    cancelAssistantApiKeyPrompt,
    resolveAssistantToolApproval,
  };
}
