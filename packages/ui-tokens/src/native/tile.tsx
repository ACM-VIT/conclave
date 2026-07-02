import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { MicOff } from "lucide-react-native";
import { avatarColor, initials } from "../core";
import { color, font, radius } from "../tokens";

/* -------------------------------------------------------------------- Tile ---
 * Flat video-tile frame. Active speaker = 2px solid accent border (NO glow).
 * Border is always 2px so layout never shifts when speaking toggles. */
export interface TileProps {
  speaking?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Tile({ speaking = false, children, style }: TileProps) {
  return (
    <View
      style={[
        styles.tile,
        { borderColor: speaking ? color.speaking : "rgba(250, 250, 250,0.1)" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ Avatar ---
 * Solid-fill circular avatar (NO gradient). */
export interface AvatarProps {
  name: string;
  id?: string;
  size?: number;
}

export function Avatar({ name, id, size = 64 }: AvatarProps) {
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(id ?? name) },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.4) }]}>{initials(name)}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- NamePlate ---
 * Bottom-left name pill. Sans (NEVER mono). */
export interface NamePlateProps {
  name: string;
  isLocal?: boolean;
  isMuted?: boolean;
  size?: number;
}

export function NamePlate({ name, isLocal, isMuted, size = 13 }: NamePlateProps) {
  return (
    <View style={styles.namePlate}>
      <Text style={[styles.nameText, { fontSize: size }]} numberOfLines={1}>
        {name}
      </Text>
      {isLocal ? <Text style={styles.youLabel}>You</Text> : null}
      {isMuted ? <MicOff size={13} color={color.accent} strokeWidth={2} /> : null}
    </View>
  );
}

/* -------------------------------------------------------------------- Pill ---*/
export interface PillProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Pill({ children, style }: PillProps) {
  return <View style={[styles.pill, style]}>{children}</View>;
}

/* ------------------------------------------------------------------- Badge ---*/
export function Badge({ count }: { count: number }) {
  if (!count || count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 9 ? "9+" : count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: radius.tile,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 2,
  },
  avatar: { alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#ffffff", fontWeight: "700", fontFamily: font.displayNative },
  namePlate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.scrim,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  nameText: { fontWeight: "500", color: color.text, fontFamily: font.sansNative },
  youLabel: { fontSize: 11, fontWeight: "500", color: color.accent, fontFamily: font.sansNative },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.scrim,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  badge: {
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
