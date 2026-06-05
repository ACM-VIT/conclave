import React from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import {
  controlButtonColors,
  type ControlButtonVariant,
  type AppButtonVariant,
} from "../core";
import { color, font, radius } from "../tokens";

type IconCmp = React.ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/* --------------------------------------------------------- ControlButton ---
 * Circular icon-only control for the mobile pill. Flat: fill / tint / border
 * only, NO shadow/glow. */
export interface ControlButtonProps {
  icon: IconCmp;
  variant?: ControlButtonVariant;
  size?: number;
  iconSize?: number;
  badge?: number;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress?: () => void;
}

export function ControlButton({
  icon: Icon,
  variant = "default",
  size = 52,
  iconSize,
  badge,
  accessibilityLabel,
  disabled,
  onPress,
}: ControlButtonProps) {
  const c = controlButtonColors(variant);
  const dim = iconSize ?? Math.round(size * 0.42);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.bg,
          borderColor: c.border === "transparent" ? "transparent" : c.border,
          opacity: disabled ? 0.35 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Icon color={c.fg} size={dim} strokeWidth={2} />
      {typeof badge === "number" && badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/* ------------------------------------------------------------- IconButton ---
 * Icon + optional label (rows in the More sheet). */
export interface IconButtonProps {
  icon: IconCmp;
  label?: string;
  active?: boolean;
  badge?: number;
  disabled?: boolean;
  onPress?: () => void;
  size?: number;
}

export function IconButton({
  icon: Icon,
  label,
  active = false,
  badge,
  disabled,
  onPress,
  size = 48,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.35 : pressed ? 0.85 : 1 }]}
    >
      <View
        style={[
          styles.iconButtonCircle,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <Icon color={active ? color.accent : color.textMuted} size={20} strokeWidth={2} />
        {typeof badge === "number" && badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
          </View>
        ) : null}
      </View>
      {label ? (
        <Text style={[styles.iconButtonLabel, active && { color: color.accent }]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/* -------------------------------------------------------------- AppButton ---
 * Text CTA. primary = solid accent fill. */
export interface AppButtonProps {
  label: string;
  variant?: AppButtonVariant;
  onPress?: () => void;
  disabled?: boolean;
  leftIcon?: IconCmp;
}

export function AppButton({ label, variant = "primary", onPress, disabled, leftIcon: Left }: AppButtonProps) {
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.appButton,
        primary
          ? { backgroundColor: color.accent }
          : { backgroundColor: "transparent", borderWidth: 1, borderColor: color.borderStrong },
        { opacity: disabled ? 0.35 : pressed ? 0.9 : 1 },
      ]}
    >
      {Left ? <Left color={primary ? "#fff" : color.text} size={18} strokeWidth={2} /> : null}
      <Text style={[styles.appButtonText, { color: primary ? "#ffffff" : color.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  iconButton: { alignItems: "center", justifyContent: "center", gap: 4 },
  iconButtonCircle: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surface,
  },
  iconButtonLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: color.textMuted,
    fontFamily: font.sansNative,
  },
  appButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: radius.pill,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  appButtonText: { fontSize: 15, fontWeight: "600", fontFamily: font.sansMediumNative },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: color.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700", fontFamily: font.sansNative },
});
