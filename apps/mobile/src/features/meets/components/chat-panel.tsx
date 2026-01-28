import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList as RNFlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatMessage } from "../types";
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

const ChatFooter = memo(function ChatFooter({
  inputValue,
  onInputChange,
  onSend,
  isGhostMode,
  inputDockPaddingBottom,
  showCommandSuggestions,
  commandSuggestions,
  activeCommandIndex,
  onPickCommand,
}: {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isGhostMode: boolean;
  inputDockPaddingBottom: number;
  showCommandSuggestions: boolean;
  commandSuggestions: CommandSuggestion[];
  activeCommandIndex: number;
  onPickCommand: (text: string) => void;
}) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.inputDock, { paddingBottom: inputDockPaddingBottom }]}
    >
      {showCommandSuggestions ? (
        <View style={styles.commandContainer}>
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
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder={
            isGhostMode ? "Ghost mode: chat disabled" : "Type a message or /..."
          }
          placeholderTextColor={SHEET_COLORS.textFaint}
          value={inputValue}
          onChangeText={onInputChange}
          onSubmitEditing={onSend}
          returnKeyType="send"
          autoCorrect
          editable={!isGhostMode}
        />
        <Pressable style={styles.sendButton} onPress={onSend}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
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
  resolveDisplayName: (userId: string) => string;
  visible?: boolean;
}

export function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  onClose,
  currentUserId,
  isGhostMode,
  resolveDisplayName,
  visible = true,
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const inputDockPaddingBottom = Math.max(8, insets.bottom);
  const [localValue, setLocalValue] = useState(input);
  const sheetRef = useRef<TrueSheet>(null);
  const listRef = useRef<RNFlatList<ChatMessage> | null>(null);
  const hasPresented = useRef(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const handleSend = useCallback(() => {
    if (!localValue.trim() || isGhostMode) return;
    onSend(localValue);
    setLocalValue("");
    onInputChange("");
  }, [localValue, onSend, onInputChange, isGhostMode]);

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
    !isGhostMode && localValue.startsWith("/") && commandSuggestions.length > 0;
  const isPickingCommand =
    showCommandSuggestions && !localValue.slice(1).includes(" ");

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
          inputDockPaddingBottom={inputDockPaddingBottom}
          showCommandSuggestions={showCommandSuggestions}
          commandSuggestions={commandSuggestions}
          activeCommandIndex={activeCommandIndex}
          onPickCommand={(text) => {
            setLocalValue(text);
            onInputChange(text);
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
            renderItem={({ item }: ListRenderItemInfo<ChatMessage>) => (
              (() => {
                const isOwn = item.userId === currentUserId;
                const actionText = getActionText(item.content);
                const displayName = isOwn
                  ? "You"
                  : resolveDisplayName(item.userId) || item.displayName;
                const timestamp = new Date(item.timestamp).toLocaleTimeString(
                  [],
                  { hour: "2-digit", minute: "2-digit" }
                );

                if (actionText) {
                  return (
                    <Text style={styles.actionText}>
                      <Text style={styles.actionName}>{displayName}</Text>{" "}
                      {actionText}
                    </Text>
                  );
                }

                return (
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
                      ]}
                    >
                      <Text style={[styles.messageText, isOwn && styles.messageTextOwn]}>
                        {item.content}
                      </Text>
                    </View>
                    <Text style={styles.messageTimestamp}>{timestamp}</Text>
                  </View>
                );
              })()
            )}
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
  actionName: {
    color: "rgba(249, 95, 74, 0.8)",
  },
  commandContainer: {
    maxHeight: 320,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    backgroundColor: "rgba(28, 28, 30, 0.96)",
    overflow: "hidden",
    marginBottom: 8,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
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
