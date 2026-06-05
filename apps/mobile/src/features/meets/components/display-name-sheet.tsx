import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { Pressable, Text, TextInput, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

interface DisplayNameSheetProps {
  visible: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  canSubmit: boolean;
  isUpdating: boolean;
  status?: { type: "success" | "error"; message: string } | null;
}

export function DisplayNameSheet({
  visible,
  value,
  onChange,
  onSubmit,
  onClose,
  canSubmit,
  isUpdating,
  status,
}: DisplayNameSheetProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

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

  const handleSubmit = useCallback(() => {
    if (!canSubmit || isUpdating) return;
    onSubmit();
  }, [canSubmit, isUpdating, onSubmit]);

  return (
    <TrueSheet
      ref={sheetRef}
      detents={["auto"]}
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>Display name</Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.inputRow}>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="Your display name"
            placeholderTextColor="rgba(250, 250, 250, 0.4)"
            style={styles.input}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
          />
          <Pressable
            onPress={handleSubmit}
            style={({ pressed }) => [
              styles.saveButton,
              (!canSubmit || isUpdating) && styles.saveButtonDisabled,
              pressed && canSubmit && !isUpdating && styles.saveButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Save display name"
          >
            <Text style={styles.saveButtonText}>
              {isUpdating ? "Saving..." : "Save"}
            </Text>
          </Pressable>
        </View>

        {status?.message ? (
          <Text
            style={[
              styles.statusText,
              status.type === "error" ? styles.statusError : styles.statusSuccess,
            ]}
          >
            {status.message}
          </Text>
        ) : null}
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
    gap: 12,
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
    backgroundColor: "rgba(250, 250, 250, 0.08)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  closeText: {
    fontSize: 12,
    color: SHEET_COLORS.text,
  },
  inputRow: {
    gap: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: SHEET_COLORS.text,
    backgroundColor: "rgba(250, 250, 250, 0.04)",
  },
  saveButton: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#F95F4A",
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  saveButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0b0b0b",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statusText: {
    fontSize: 12,
  },
  statusError: {
    color: "rgba(248, 113, 113, 0.9)",
  },
  statusSuccess: {
    color: "rgba(34, 197, 94, 0.9)",
  },
});
