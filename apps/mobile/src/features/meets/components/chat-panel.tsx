import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  FlatList as RNFlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatMessage } from "../types";
import type { Participant } from "../types";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { FlatList, Pressable, Text, TextInput, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";
import { getActionText, getCommandSuggestions } from "../chat-commands";

type CommandSuggestion = ReturnType<typeof getCommandSuggestions>[number];

const ChatHeader = memo(function ChatHeader({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.headerRow}>
      <Text style={styles.headerText}>Chat</Text>
      <Pressable onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeText}>Done</Text>
      </Pressable>
    </View>
  );
});

const MessageRow = memo(function MessageRow({
  item,
  isOwn,
  isNew,
  displayName,
  actionText,
  directMessageLabel,
  timestamp,
}: {
  item: ChatMessage;
  isOwn: boolean;
  isNew: boolean;
  displayName: string;
  actionText: string | null;
  directMessageLabel: string | null;
  timestamp: string;
}) {
  const scale = useRef(new Animated.Value(isNew ? 0.94 : 1)).current;
  const translateY = useRef(new Animated.Value(isNew ? 8 : 0)).current;
  const opacity = useRef(new Animated.Value(isNew ? 0 : 1)).current;

  useEffect(() => {
    if (!isNew) return;
    scale.setValue(0.94);
    translateY.setValue(8);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        speed: 18,
        bounciness: 8,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 18,
        bounciness: 6,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [isNew, opacity, scale, translateY]);


  
  const displayContent = item.content;

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }, { scale }] }}>
      {actionText ? (
        <View style={styles.actionWrap}>
          {directMessageLabel ? (
            <Text style={styles.dmLabel}>{directMessageLabel}</Text>
          ) : null}
          <Text style={styles.actionText}>
            <Text style={styles.actionName}>{displayName}</Text> {actionText}
          </Text>
        </View>
      ) : (
        <View
          style={[
            styles.messageRow,
            isOwn ? styles.messageRowRight : styles.messageRowLeft,
          ]}
        >
          {!isOwn ? (
            <Text style={styles.messageName}>{displayName}</Text>
          ) : null}
          <View
            style={[
              styles.messageBubble,
              isOwn ? styles.bubbleOwn : styles.bubbleOther,
              item.isDirect ? styles.bubbleDm : null,
            ]}
          >
            {directMessageLabel ? (
              <Text style={styles.dmLabel}>{directMessageLabel}</Text>
            ) : null}
            <Text style={[styles.messageText, isOwn && styles.messageTextOwn]}>
              {displayContent}
            </Text>
          </View>
          <Text style={styles.messageTimestamp}>{timestamp}</Text>
        </View>
      )}
    </Animated.View>
  );
});

const ChatFooter = memo(function ChatFooter({
  inputValue,
  onInputChange,
  onSend,
  isGhostMode,
  isChatLocked,
  isAdmin,
  inputDockPaddingBottom,
  showCommandSuggestions,
  commandSuggestions,
  activeCommandIndex,
  onPickCommand,
  showMentionSuggestions,
  mentionSuggestions,
  onPickMention,
  isDmEnabled,
}: {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isGhostMode: boolean;
  isChatLocked: boolean;
  isAdmin: boolean;
  inputDockPaddingBottom: number;
  showCommandSuggestions: boolean;
  commandSuggestions: CommandSuggestion[];
  activeCommandIndex: number;
  onPickCommand: (text: string) => void;
  showMentionSuggestions: boolean;
  mentionSuggestions: { userId: string; displayName: string; mentionToken: string }[];
  onPickMention: (mentionToken: string) => void;
  isDmEnabled: boolean;
}) {
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.inputDock, { paddingBottom: inputDockPaddingBottom }]}
    >
      <View style={styles.inputShell}>
        {showCommandSuggestions ? (
          <View style={[styles.commandContainer, styles.commandOverlay]}>
            <RNFlatList
              data={commandSuggestions}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              renderItem={({ item, index }) => {
                const isActive = index === activeCommandIndex;
                return (
                  <Pressable
                    onPress={() => onPickCommand(item.insertText)}
                    style={[
                      styles.commandRow,
                      isActive && styles.commandRowActive,
                    ]}
                  >
                    <View style={styles.commandHeader}>
                      <Text style={styles.commandLabel}>/{item.label}</Text>
                      <Text style={styles.commandUsage}>{item.usage}</Text>
                    </View>
                    <Text style={styles.commandDescription}>
                      {item.description}
                    </Text>
                  </Pressable>
                );
              }}
            />
          </View>
        ) : null}
        {showMentionSuggestions && isDmEnabled ? (
          <View style={[styles.commandContainer, styles.commandOverlay]}>
            <View style={styles.mentionHeader}>
              <Text style={styles.mentionHeaderText}>💬 Private message to...</Text>
            </View>
            <RNFlatList
              data={mentionSuggestions}
              keyExtractor={(item) => item.userId}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => onPickMention(item.mentionToken)}
                  style={styles.commandRow}
                >
                  <Text style={styles.commandLabel}>{item.displayName}</Text>
                </Pressable>
              )}
            />
          </View>
        ) : null}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder={
              isGhostMode
                ? "Ghost mode: chat disabled"
                : isChatLocked && !isAdmin
                  ? "Chat locked by host"
                  : isDmEnabled
                    ? "Message or @name for DM..."
                    : "Type a message or /..."
            }
            placeholderTextColor={SHEET_COLORS.textFaint}
            value={inputValue}
            onChangeText={onInputChange}
            onSubmitEditing={onSend}
            returnKeyType="send"
            autoCorrect
            editable={!isChatDisabled}
          />
          <Pressable
            style={styles.sendButton}
            onPress={onSend}
            disabled={isChatDisabled || !inputValue.trim()}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
});

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: (value: string) => void;
  onClose: () => void;
  currentUserId: string;
  isGhostMode: boolean;
  isChatLocked: boolean;
  isDmEnabled?: boolean;
  isAdmin: boolean;
  resolveDisplayName: (userId: string) => string;
  participants?: Participant[];
  visible?: boolean;
}

// Mirrors the server's normalizeLookupToken so the mention token we insert
// is always resolvable server-side.
const normalizeMentionToken = (displayName: string): string =>
  displayName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const getMentionTokenForUser = (userId: string, displayName: string): string => {
  const displayNameToken = normalizeMentionToken(displayName);
  if (displayNameToken) {
    return displayNameToken;
  }
  const normalizedUserId = normalizeMentionToken(userId);
  if (normalizedUserId) {
    return normalizedUserId;
  }
  const base = userId.split("#")[0] || userId;
  const handle = base.split("@")[0] || base;
  return normalizeMentionToken(handle) || normalizeMentionToken(base);
};

type MentionInputMode = "at" | "dm";

export function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode,
  isChatLocked,
  isDmEnabled = true,
  isAdmin,
  resolveDisplayName,
  participants = [],
  visible = true,
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const inputDockPaddingBottom = Math.max(8, insets.bottom);
  const [localValue, setLocalValue] = useState(input);
  const sheetRef = useRef<TrueSheet>(null);
  const listRef = useRef<RNFlatList<ChatMessage> | null>(null);
  const hasPresented = useRef(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const hasInitializedRef = useRef(false);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const isChatDisabled = isGhostMode || (isChatLocked && !isAdmin);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const handleSend = useCallback(() => {
    if (!localValue.trim() || isChatDisabled) return;
    const trimmed = localValue.trim();
    onSend(trimmed);
    setLocalValue("");
    onInputChange("");
  }, [localValue, onSend, onInputChange, isChatDisabled]);

  useEffect(() => {
    if (input !== localValue) {
      setLocalValue(input);
    }
  }, [input, localValue]);

  const commandSuggestions = useMemo(
    () => getCommandSuggestions(localValue),
    [localValue]
  );
  const showCommandSuggestions =
    !isChatDisabled && localValue.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !localValue.slice(1).includes(" ");

  // @mention and /dm target autocomplete
  const mentionContext = useMemo(() => {
    if (isChatDisabled || !isDmEnabled) return null;
    const value = localValue.trimStart();

    if (value.startsWith("@")) {
      const afterAt = value.slice(1);
      if (afterAt.includes(" ")) return null;
      return {
        mode: "at" as MentionInputMode,
        query: afterAt.toLowerCase(),
      };
    }

    const dmTargetMatch = value.match(/^\/dm\s*([^\s]*)$/i);
    if (!dmTargetMatch) return null;
    return {
      mode: "dm" as MentionInputMode,
      query: (dmTargetMatch[1] || "").toLowerCase(),
    };
  }, [isChatDisabled, isDmEnabled, localValue]);
  const mentionMode = mentionContext?.mode ?? null;
  const mentionQuery = mentionContext?.query ?? null;

  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const normalizedMentionQuery = normalizeMentionToken(mentionQuery);
    return participants
      .filter((p) => p.userId !== currentUserId)
      .map((p) => {
        const displayName = resolveDisplayName(p.userId);
        return {
          userId: p.userId,
          displayName,
          mentionToken: getMentionTokenForUser(p.userId, displayName),
        };
      })
      .filter((p) =>
        mentionQuery === ""
          ? true
          : p.displayName.toLowerCase().includes(mentionQuery) ||
            p.mentionToken.toLowerCase().includes(normalizedMentionQuery)
      );
  }, [mentionQuery, participants, currentUserId, resolveDisplayName]);

  const showMentionSuggestions = mentionQuery !== null && mentionSuggestions.length > 0;

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [localValue]);

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length]);

  useEffect(() => {
    hasInitializedRef.current = true;
  }, []);

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


  useEffect(() => {
    if (visible) {
      hasPresented.current = true;
      void sheetRef.current?.present(0);
    } else if (hasPresented.current) {
      void sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    return () => {
      if (hasPresented.current) {
        void sheetRef.current?.dismiss();
      }
    };
  }, []);

  return (
    <TrueSheet
      ref={sheetRef}
      detents={[0.6, 1]}
      scrollable
      header={<ChatHeader onClose={handleDismiss} />}
      headerStyle={styles.headerContainer}
      footer={
        <ChatFooter
          inputValue={localValue}
          onInputChange={(value) => {
            setLocalValue(value);
            onInputChange(value);
          }}
          onSend={handleSend}
          isGhostMode={isGhostMode}
          isChatLocked={isChatLocked}
          isAdmin={isAdmin}
          isDmEnabled={isDmEnabled}
          inputDockPaddingBottom={inputDockPaddingBottom}
          showCommandSuggestions={showCommandSuggestions}
          commandSuggestions={commandSuggestions}
          activeCommandIndex={activeCommandIndex}
          onPickCommand={(text) => {
            setLocalValue(text);
            onInputChange(text);
          }}
          showMentionSuggestions={showMentionSuggestions}
          mentionSuggestions={mentionSuggestions}
          onPickMention={(token) => {
            const next =
              mentionMode === "dm" ? `/dm ${token} ` : `@${token} `;
            setLocalValue(next);
            onInputChange(next);
          }}
        />
      }
      footerStyle={styles.footerContainer}
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.listWrapper}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item: ChatMessage) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }: ListRenderItemInfo<ChatMessage>) => {
              const isOwn = item.userId === currentUserId;
              const actionText = getActionText(item.content);
              const displayName = isOwn
                ? "You"
                : resolveDisplayName(item.userId) || item.displayName;
              const directMessageLabel = item.isDirect
                ? isOwn
                  ? `Sent privately to ${item.dmTargetDisplayName ||
                  resolveDisplayName(item.dmTargetUserId || item.userId)
                  }`
                  : "Sent privately"
                : null;
              const timestamp = new Date(item.timestamp).toLocaleTimeString(
                [],
                { hour: "2-digit", minute: "2-digit" }
              );
              const isNew = hasInitializedRef.current && newMessageIds.has(item.id);

              return (
                <MessageRow
                  item={item}
                  isOwn={isOwn}
                  isNew={isNew}
                  displayName={displayName}
                  actionText={actionText}
                  directMessageLabel={directMessageLabel}
                  timestamp={timestamp}
                />
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>
                  No messages yet.{"\n"}Start the conversation!
                </Text>
              </View>
            }
          />
        </View>
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 12,
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  footerContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  headerText: {
    fontSize: 16,
    fontWeight: "600",
    color: SHEET_COLORS.text,
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(254, 252, 217, 0.08)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  closeText: {
    fontSize: 12,
    color: SHEET_COLORS.text,
  },
  listWrapper: {
    flex: 1,
  },
  listContent: {
    gap: 12,
    paddingBottom: 8,
    flexGrow: 1,
    justifyContent: "flex-start",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    color: SHEET_COLORS.textMuted,
  },
  messageRow: {
    gap: 4,
  },
  messageRowLeft: {
    alignItems: "flex-start",
  },
  messageRowRight: {
    alignItems: "flex-end",
  },
  messageName: {
    fontSize: 10,
    color: SHEET_COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  messageBubble: {
    maxWidth: "80%",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOwn: {
    backgroundColor: "#F95F4A",
    borderBottomRightRadius: 6,
  },
  bubbleOther: {
    backgroundColor: "rgba(42, 42, 42, 0.9)",
    borderBottomLeftRadius: 6,
  },
  bubbleDm: {
    borderLeftWidth: 2,
    borderLeftColor: "rgba(251, 191, 36, 0.5)",
  },
  messageText: {
    fontSize: 14,
    color: SHEET_COLORS.text,
  },
  messageTextOwn: {
    color: "#FFFFFF",
  },
  messageTimestamp: {
    fontSize: 9,
    color: SHEET_COLORS.textFaint,
  },
  actionText: {
    fontSize: 11,
    fontStyle: "italic",
    color: SHEET_COLORS.textMuted,
    paddingHorizontal: 4,
  },
  actionWrap: {
    gap: 2,
    paddingHorizontal: 4,
  },
  actionName: {
    color: "rgba(249, 95, 74, 0.8)",
  },
  dmLabel: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: "rgba(251, 191, 36, 0.85)",
    marginBottom: 2,
  },
  mentionHeader: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  mentionHeaderText: {
    fontSize: 10,
    color: SHEET_COLORS.textFaint,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  commandContainer: {
    maxHeight: 320,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    backgroundColor: "rgba(28, 28, 30, 0.96)",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  commandOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    marginBottom: 8,
    zIndex: 20,
  },
  commandRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  commandRowActive: {
    backgroundColor: "rgba(249, 95, 74, 0.2)",
  },
  commandHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  commandLabel: {
    fontSize: 12,
    color: SHEET_COLORS.text,
    fontWeight: "600",
  },
  commandUsage: {
    fontSize: 10,
    color: SHEET_COLORS.textMuted,
  },
  commandDescription: {
    fontSize: 10,
    color: SHEET_COLORS.textFaint,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 56,
  },
  inputDock: {
    paddingTop: 8,
    paddingBottom: 4,
  },
  inputShell: {
    position: "relative",
  },
  input: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(254, 252, 217, 0.06)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    color: SHEET_COLORS.text,
  },
  sendButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#F95F4A",
  },
  sendText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#FFFFFF",
  },
});
