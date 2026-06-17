import React, { useCallback, useMemo, useState } from "react";
import {
  StyleSheet,
  View,
  Pressable,
  Text,
  ScrollView,
} from "react-native";
import {
  Lock,
  Plus,
  Trash2,
} from "lucide-react-native";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import { useAppPresence } from "../../../../sdk/hooks/useAppPresence";
import { useApps } from "../../../../sdk/hooks/useApps";
import { useToolState } from "../../shared/hooks/useToolState";
import { WhiteboardNativeCanvas } from "./WhiteboardNativeCanvas";
import { WhiteboardNativeToolbar } from "./WhiteboardNativeToolbar";
import { useWhiteboardPages } from "../../shared/hooks/useWhiteboardPages";
import { updateElement, getPageElements } from "../../core/doc/index";

type EditingTextState = {
  pageId: string;
  elementId: string;
  text: string;
};

export function WhiteboardNativeApp() {
  const { user, isAdmin } = useApps();
  const { doc, awareness, locked } = useAppDoc("whiteboard");
  const { states } = useAppPresence("whiteboard");
  const { tool, setTool, settings, setSettings } = useToolState();
  const isReadOnly = locked && !isAdmin;
  const { pages, activePageId, createPage, setActive, deletePage } = useWhiteboardPages(
    doc,
    { readOnly: isReadOnly }
  );

  const activePage = useMemo(() => {
    return pages.find((page) => page.id === activePageId) ?? pages[0];
  }, [pages, activePageId]);

  const [editingText, setEditingText] = useState<EditingTextState | null>(null);

  const handleRequestTextEdit = useCallback(
    (pageId: string, elementId: string, currentText: string) => {
      setEditingText({ pageId, elementId, text: currentText });
    },
    [],
  );

  const saveEditingText = useCallback(() => {
    if (!editingText) return;
    const elements = getPageElements(doc, editingText.pageId);
    const el = elements.find((e) => e.id === editingText.elementId);
    if (el && (el.type === "text" || el.type === "sticky")) {
      const updated = { ...el, text: editingText.text };
      updateElement(doc, editingText.pageId, updated);
    }
  }, [editingText, doc]);

  const handleTextSubmit = useCallback(() => {
    saveEditingText();
    setEditingText(null);
  }, [saveEditingText]);

  const handleTextBlur = useCallback(() => {
    handleTextSubmit();
  }, [handleTextSubmit]);

  const handleTextCancel = useCallback(() => {
    setEditingText(null);
  }, []);

  const handleTextChange = useCallback((text: string) => {
    setEditingText((prev) => (prev ? { ...prev, text } : null));
  }, []);

  if (!activePage) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Loading whiteboard...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.canvasContainer}>
        <WhiteboardNativeCanvas
          doc={doc}
          awareness={awareness}
          pageId={activePage.id}
          tool={tool}
          settings={settings}
          locked={isReadOnly}
          user={user}
          states={states}
          onRequestTextEdit={handleRequestTextEdit}
          editingText={editingText}
          onEditingTextChange={handleTextChange}
          onEditingTextSubmit={handleTextSubmit}
          onEditingTextBlur={handleTextBlur}
          onEditingTextCancel={handleTextCancel}
        />
      </View>

      <View style={styles.topFloat} pointerEvents="box-none">
        <View style={styles.topBar}>
          {locked ? (
            <View style={styles.lockedPill}>
              <Lock size={11} color="rgba(253,230,138,0.95)" strokeWidth={2} />
            </View>
          ) : null}

          <View style={styles.topDivider} />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pageScrollContent}
            style={styles.pageScroll}
          >
            {pages.map((page, index) => (
              <Pressable
                key={page.id}
                onPress={() => setActive(page.id)}
                style={[
                  styles.pageChip,
                  page.id === activePage.id && styles.pageChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.pageChipText,
                    page.id === activePage.id && styles.pageChipTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {index + 1}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            onPress={() => createPage()}
            disabled={isReadOnly}
            style={[styles.pageAction, isReadOnly && styles.disabled]}
          >
            <Plus size={14} color="rgba(254,252,217,0.7)" strokeWidth={2} />
          </Pressable>
          <Pressable
            onPress={() => deletePage(activePage.id)}
            disabled={isReadOnly || pages.length <= 1}
            style={[
              styles.pageAction,
              (isReadOnly || pages.length <= 1) && styles.disabled,
            ]}
          >
            <Trash2 size={13} color="rgba(254,252,217,0.7)" strokeWidth={1.8} />
          </Pressable>
        </View>
      </View>

      <WhiteboardNativeToolbar
        tool={tool}
        onToolChange={setTool}
        settings={settings}
        onSettingsChange={setSettings}
        locked={isReadOnly}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#060606",
  },
  canvasContainer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  topFloat: {
    position: "absolute",
    top: 8,
    left: 12,
    right: 12,
    alignItems: "center",
    zIndex: 40,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: "rgba(10,10,10,0.88)",
    borderWidth: 1,
    borderColor: "rgba(254,252,217,0.08)",
    alignSelf: "center",
    maxWidth: "100%",
  },
  lockedPill: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: "rgba(251,191,36,0.15)",
  },
  topDivider: {
    width: 1,
    height: 18,
    backgroundColor: "rgba(254,252,217,0.1)",
    marginHorizontal: 4,
  },
  pageScroll: {
    flexShrink: 1,
  },
  pageScrollContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  pageChip: {
    width: 28,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  pageChipActive: {
    backgroundColor: "#F95F4A",
  },
  pageChipText: {
    color: "rgba(254,252,217,0.55)",
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  pageChipTextActive: {
    color: "#fff",
  },
  pageAction: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  disabled: {
    opacity: 0.3,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: "#FEFCD9",
    fontSize: 14,
  },
});
