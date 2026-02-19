import React, { useState, useCallback, type ComponentType } from "react";
import {
  StyleSheet,
  View,
  Pressable,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import {
  MousePointer2,
  Pencil,
  Highlighter,
  Eraser,
  Square,
  Circle,
  Minus,
  ArrowRight,
  Baseline,
  StickyNote,
  Download,
  Palette,
  X,
} from "lucide-react-native";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { TOOL_COLORS } from "../../shared/constants/tools";

type LucideIcon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const TOOLS: { id: ToolKind; icon: LucideIcon }[] = [
  { id: "select", icon: MousePointer2 },
  { id: "pen", icon: Pencil },
  { id: "highlighter", icon: Highlighter },
  { id: "eraser", icon: Eraser },
  { id: "rect", icon: Square },
  { id: "ellipse", icon: Circle },
  { id: "line", icon: Minus },
  { id: "arrow", icon: ArrowRight },
  { id: "text", icon: Baseline },
  { id: "sticky", icon: StickyNote },
];
const STROKE_WIDTHS = [2, 4, 6, 10];

export function WhiteboardNativeToolbar({
  tool,
  onToolChange,
  settings,
  onSettingsChange,
  locked,
  onExport,
}: {
  tool: ToolKind;
  onToolChange: (tool: ToolKind) => void;
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
  onExport: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { width: screenWidth } = useWindowDimensions();

  const toggleExpand = useCallback(() => setExpanded((prev) => !prev), []);

  const iconSize = 18;
  const btnSize = 36;

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      {/* Expandable options panel — colors + stroke widths */}
      {expanded && (
        <View style={[styles.optionsPanel, { maxWidth: screenWidth - 32 }]}>
          <View style={styles.optionsRow}>
            {TOOL_COLORS.map((color) => (
              <Pressable
                key={color}
                disabled={locked}
                onPress={() =>
                  onSettingsChange({
                    ...settings,
                    strokeColor: color,
                    textColor: color,
                  })
                }
                style={[
                  styles.colorDot,
                  { backgroundColor: color },
                  settings.strokeColor === color && styles.colorDotActive,
                  locked && styles.disabled,
                ]}
              />
            ))}
          </View>
          <View style={styles.optionsRow}>
            {STROKE_WIDTHS.map((size) => (
              <Pressable
                key={size}
                disabled={locked}
                onPress={() =>
                  onSettingsChange({ ...settings, strokeWidth: size })
                }
                style={[
                  styles.sizeBtn,
                  settings.strokeWidth === size && styles.sizeBtnActive,
                  locked && styles.disabled,
                ]}
              >
                <View
                  style={[
                    styles.sizeDot,
                    {
                      width: Math.min(size + 2, 14),
                      height: Math.min(size + 2, 14),
                      borderRadius: Math.min(size + 2, 14) / 2,
                    },
                  ]}
                />
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={[styles.bar, { maxWidth: screenWidth - 24 }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          bounces={false}
        >
          {TOOLS.map((item) => {
            const Icon = item.icon;
            const isActive = tool === item.id;
            const isDisabled = locked && item.id !== "select";
            return (
              <Pressable
                key={item.id}
                onPress={() => onToolChange(item.id)}
                disabled={isDisabled}
                style={[
                  styles.toolBtn,
                  { width: btnSize, height: btnSize },
                  isActive && styles.toolBtnActive,
                  isDisabled && styles.disabled,
                ]}
              >
                <Icon
                  size={iconSize}
                  color={isActive ? "#fff" : "rgba(254,252,217,0.7)"}
                  strokeWidth={isActive ? 2.2 : 1.6}
                />
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.separator} />

        <Pressable
          onPress={toggleExpand}
          style={[
            styles.toolBtn,
            { width: btnSize, height: btnSize },
            expanded && styles.toolBtnActive,
          ]}
        >
          {expanded ? (
            <X size={iconSize} color="#fff" strokeWidth={2} />
          ) : (
            <Palette size={iconSize} color="rgba(254,252,217,0.7)" strokeWidth={1.6} />
          )}
        </Pressable>

        <Pressable
          onPress={onExport}
          style={[styles.toolBtn, { width: btnSize, height: btnSize }]}
        >
          <Download size={iconSize} color="rgba(254,252,217,0.7)" strokeWidth={1.6} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 4,
    paddingRight: 4,
    paddingVertical: 4,
    backgroundColor: "rgba(10,10,10,0.94)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(254,252,217,0.1)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    paddingRight: 2,
  },
  toolBtn: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  toolBtnActive: {
    backgroundColor: "#F95F4A",
  },
  disabled: {
    opacity: 0.3,
  },
  separator: {
    width: 1,
    height: 20,
    backgroundColor: "rgba(254,252,217,0.12)",
    marginHorizontal: 3,
    flexShrink: 0,
  },
  optionsPanel: {
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "rgba(10,10,10,0.94)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(254,252,217,0.1)",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
  optionsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  colorDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: {
    borderColor: "#fff",
    shadowColor: "#fff",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  sizeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  sizeBtnActive: {
    borderColor: "#F95F4A",
    backgroundColor: "rgba(249,95,74,0.18)",
  },
  sizeDot: {
    backgroundColor: "rgba(254,252,217,0.85)",
  },
});
