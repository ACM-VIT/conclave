import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as Haptics from "expo-haptics";
import { RTCView } from "react-native-webrtc";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown, FadeInUp } from "react-native-reanimated";
import {
  ArrowLeft,
  ArrowRight,
  Mic,
  MicOff,
  Plus,
  Video,
  VideoOff,
} from "lucide-react-native";
import type { MeetError } from "../types";
import {
  generateRoomCode,
  sanitizeRoomCodeInput,
  ROOM_CODE_MAX_LENGTH,
} from "../utils";
import { useDeviceLayout } from "../hooks/use-device-layout";
import { ErrorBanner } from "./error-banner";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  SafeAreaView,
} from "@/tw";
import { DotGridBackground } from "@/components/dot-grid-background";

const COLORS = {
  primaryOrange: "#F95F4A",
  primaryPink: "#FF007A",
  cream: "#FEFCD9",
  dark: "#060606",
  darkAlt: "#0d0e0d",
  surface: "#1a1a1a",
  surfaceLight: "#252525",
  surfaceHover: "#2a2a2a",
  creamLight: "rgba(254, 252, 217, 0.4)",
  creamLighter: "rgba(254, 252, 217, 0.3)",
  creamDim: "rgba(254, 252, 217, 0.1)",
  orangeLight: "rgba(249, 95, 74, 0.4)",
  orangeDim: "rgba(249, 95, 74, 0.2)",
} as const;

type Phase = "welcome" | "auth" | "join";

interface JoinScreenProps {
  roomId: string;
  onRoomIdChange: (value: string) => void;
  onJoinRoom: (roomId: string, options?: { isHost?: boolean }) => void;
  onIsAdminChange?: (isAdmin: boolean) => void;
  isLoading: boolean;
  displayNameInput: string;
  onDisplayNameInputChange: (value: string) => void;
  isMuted: boolean;
  isCameraOff: boolean;
  localStream: MediaStream | null;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  showPermissionHint: boolean;
  meetError?: MeetError | null;
  onDismissMeetError?: () => void;
  onRetryMedia?: () => void;
  forceJoinOnly?: boolean;
}

export function JoinScreen({
  roomId,
  onRoomIdChange,
  onJoinRoom,
  onIsAdminChange,
  isLoading,
  displayNameInput,
  onDisplayNameInputChange,
  isMuted,
  isCameraOff,
  localStream,
  onToggleMute,
  onToggleCamera,
  showPermissionHint,
  meetError,
  onDismissMeetError,
  onRetryMedia,
  forceJoinOnly = false,
}: JoinScreenProps) {
  const insets = useSafeAreaInsets();
  const { layout, isTablet, spacing, width: screenWidth } = useDeviceLayout();
  const [phase, setPhase] = useState<Phase>(forceJoinOnly ? "join" : "welcome");
  const [guestName, setGuestName] = useState("");
  const [activeTab, setActiveTab] = useState<"new" | "join">(
    forceJoinOnly ? "join" : "new"
  );

  const haptic = useCallback(() => {
    Haptics.selectionAsync().catch(() => { });
  }, []);

  const canJoin = roomId.trim().length > 0;

  const handleRoomChange = useCallback(
    (value: string) => {
      onRoomIdChange(
        sanitizeRoomCodeInput(value).slice(0, ROOM_CODE_MAX_LENGTH)
      );
    },
    [onRoomIdChange]
  );

  const handleContinueAsGuest = useCallback(() => {
    if (!guestName.trim()) return;
    haptic();
    onDisplayNameInputChange(guestName.trim());
    setPhase("join");
  }, [guestName, haptic, onDisplayNameInputChange]);

  const handleCreateRoom = useCallback(() => {
    haptic();
    onIsAdminChange?.(true);
    const code = generateRoomCode();
    onRoomIdChange(code);
    onJoinRoom(code, { isHost: true });
  }, [haptic, onIsAdminChange, onRoomIdChange, onJoinRoom]);

  const handleJoin = useCallback(() => {
    if (!canJoin || isLoading) return;
    haptic();
    onIsAdminChange?.(false);
    onJoinRoom(roomId, { isHost: false });
  }, [canJoin, isLoading, haptic, onIsAdminChange, onJoinRoom, roomId]);

  const userInitial = displayNameInput?.[0]?.toUpperCase() || "?";

  useEffect(() => {
    if (forceJoinOnly) return;
    if (phase !== "join") return;
    onIsAdminChange?.(activeTab === "new");
  }, [activeTab, forceJoinOnly, onIsAdminChange, phase]);

  if (phase === "welcome") {
    return (
      <DotGridBackground>
        <SafeAreaView style={styles.flex1}>
          <ScrollView
            contentContainerStyle={styles.centerContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Animated.View entering={FadeIn.duration(600)} style={styles.centerItems}>
              <Text style={[styles.welcomeLabel, { color: COLORS.creamLight }]}>
                welcome to
              </Text>

              <View style={styles.brandingRow}>
                <Text style={[styles.bracket, { color: COLORS.orangeLight }]}>
                  [
                </Text>
                <Text style={[styles.brandTitle, { color: COLORS.cream }]}>
                  c0nclav3
                </Text>
                <Text style={[styles.bracket, { color: COLORS.orangeLight }]}>
                  ]
                </Text>
              </View>

              <Text style={[styles.tagline, { color: COLORS.creamLighter }]}>
                ACM-VIT's in-house video conferencing platform
              </Text>

              <Pressable
                onPress={() => {
                  haptic();
                  setPhase("auth");
                }}
                style={[styles.primaryButton, { backgroundColor: COLORS.primaryOrange }]}
              >
                <Text style={styles.primaryButtonText}>LET'S GO</Text>
                <ArrowRight size={16} color="#FFFFFF" />
              </Pressable>
            </Animated.View>
          </ScrollView>
        </SafeAreaView>
      </DotGridBackground>
    );
  }

  if (phase === "auth") {
    return (
      <DotGridBackground>
        <SafeAreaView style={styles.flex1}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.flex1}
          >
            <ScrollView
              style={styles.flex1}
              contentContainerStyle={styles.authContent}
              keyboardShouldPersistTaps="handled"
            >
              <Animated.View entering={FadeInDown.duration(400)} style={styles.authCard}>
                <View style={styles.authHeader}>
                  <Text style={[styles.authTitle, { color: COLORS.cream }]}>
                    Join
                  </Text>
                  <Text style={[styles.authSubtitle, { color: COLORS.creamLight }]}>
                    choose how to continue
                  </Text>
                </View>

                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: COLORS.creamLight }]}>
                    Your name
                  </Text>
                  <TextInput
                    style={[styles.textInput, {
                      backgroundColor: COLORS.surface,
                      borderColor: COLORS.creamDim,
                      color: COLORS.cream,
                    }]}
                    placeholder="Enter your name"
                    placeholderTextColor={COLORS.creamLighter}
                    value={guestName}
                    onChangeText={setGuestName}
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={handleContinueAsGuest}
                  />

                  <Pressable
                    onPress={handleContinueAsGuest}
                    disabled={!guestName.trim()}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: guestName.trim()
                          ? COLORS.primaryOrange
                          : COLORS.creamDim,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.secondaryButtonText,
                        {
                          color: guestName.trim()
                            ? "#FFFFFF"
                            : COLORS.creamLighter,
                        },
                      ]}
                    >
                      Continue as Guest
                    </Text>
                  </Pressable>
                </View>

                <Pressable
                  onPress={() => {
                    haptic();
                    setPhase("welcome");
                  }}
                  style={styles.backButton}
                >
                  <View style={styles.backRow}>
                    <ArrowLeft size={14} color={COLORS.creamLighter} />
                    <Text style={[styles.backButtonText, { color: COLORS.creamLighter }]}>
                      back
                    </Text>
                  </View>
                </Pressable>
              </Animated.View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </DotGridBackground>
    );
  }

  // iPad-specific layout calculations
  const isIpadLayout = isTablet && layout !== "compact";
  const maxContentWidth = isIpadLayout ? 1200 : undefined;
  const videoPreviewFlex = isIpadLayout ? 1.15 : undefined;
  const joinCardFlex = isIpadLayout ? 0.85 : undefined;

  return (
    <DotGridBackground>
      <SafeAreaView style={styles.flex1}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex1}
        >
          <View style={styles.flex1}>
            <ScrollView
              style={styles.flex1}
              contentContainerStyle={[
                styles.joinContent,
                isIpadLayout && styles.joinContentTablet,
                isIpadLayout && { maxWidth: maxContentWidth, alignSelf: "center" as const, width: "100%" as const },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              {meetError ? (
                <ErrorBanner
                  meetError={meetError}
                  onDismiss={onDismissMeetError}
                  primaryActionLabel={onRetryMedia ? "Retry Permissions" : undefined}
                  onPrimaryAction={onRetryMedia}
                />
              ) : null}

              {/* Two-column layout wrapper for iPad */}
              <View style={isIpadLayout ? styles.twoColumnLayout : undefined}>
                {/* Video Preview Column */}
                <Animated.View
                  entering={FadeIn.duration(400)}
                  style={isIpadLayout ? { flex: videoPreviewFlex } : undefined}
                >
                  <Text style={[styles.sectionLabel, { color: COLORS.creamLight }]}>
                    Preview
                  </Text>
                  <View style={[
                    styles.videoPreview,
                    {
                      backgroundColor: COLORS.surface,
                      borderColor: COLORS.creamDim,
                    },
                    isIpadLayout && styles.videoPreviewTablet,
                  ]}>
                    {localStream && !isCameraOff ? (
                      <RTCView
                        streamURL={localStream.toURL()}
                        style={styles.rtcView}
                        mirror
                      />
                    ) : (
                      <View style={styles.noVideoContainer}>
                        <View style={[styles.userAvatar, {
                          backgroundColor: COLORS.orangeDim,
                          borderColor: COLORS.creamDim,
                        }]}>
                          <Text style={[styles.userInitial, { color: COLORS.cream }]}>
                            {userInitial}
                          </Text>
                        </View>
                      </View>
                    )}

                    <View style={styles.nameOverlay}>
                      <Text style={styles.overlayText}>
                        {displayNameInput || "Guest"}
                      </Text>
                    </View>

                    <View style={styles.mediaControlsContainer}>
                      <View style={styles.mediaControlsPill}>
                        <Pressable
                          onPress={() => {
                            haptic();
                            onToggleMute();
                          }}
                          style={[
                            styles.mediaButton,
                            isMuted && styles.mediaButtonActive,
                          ]}
                        >
                          {isMuted ? (
                            <MicOff size={18} color="#FFFFFF" />
                          ) : (
                            <Mic size={18} color="#FFFFFF" />
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            haptic();
                            onToggleCamera();
                          }}
                          style={[
                            styles.mediaButton,
                            isCameraOff && styles.mediaButtonActive,
                          ]}
                        >
                          {isCameraOff ? (
                            <VideoOff size={18} color="#FFFFFF" />
                          ) : (
                            <Video size={18} color="#FFFFFF" />
                          )}
                        </Pressable>
                      </View>
                    </View>
                  </View>

                  <View style={styles.preflightRow}>
                    <Text style={[styles.preflightLabel, { color: COLORS.creamLight }]}>
                      Preflight
                    </Text>
                    <View style={[styles.statusPill, { borderColor: COLORS.creamDim }]}>
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: !isMuted ? "#34d399" : COLORS.primaryOrange },
                        ]}
                      />
                      <Text style={styles.statusText}>
                        Mic {!isMuted ? "On" : "Off"}
                      </Text>
                    </View>
                    <View style={[styles.statusPill, { borderColor: COLORS.creamDim }]}>
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: !isCameraOff ? "#34d399" : COLORS.primaryOrange },
                        ]}
                      />
                      <Text style={styles.statusText}>
                        Camera {!isCameraOff ? "On" : "Off"}
                      </Text>
                    </View>
                  </View>
                </Animated.View>

                {/* Join Card Column */}
                <Animated.View
                  entering={FadeInUp.delay(100).duration(400)}
                  style={[
                    styles.joinCard,
                    { borderColor: COLORS.creamDim },
                    isIpadLayout && { flex: joinCardFlex, marginTop: 0, marginLeft: spacing.lg },
                  ]}
                >
                  {!forceJoinOnly && (
                    <View style={[styles.tabContainer, { backgroundColor: COLORS.surface }]}>
                      <Pressable
                        onPress={() => {
                          haptic();
                          setActiveTab("new");
                        }}
                        style={[
                          styles.tab,
                          activeTab === "new" && { backgroundColor: COLORS.primaryOrange },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tabText,
                            { color: activeTab === "new" ? "#FFFFFF" : COLORS.creamLight },
                          ]}
                        >
                          New Meeting
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          haptic();
                          setActiveTab("join");
                        }}
                        style={[
                          styles.tab,
                          activeTab === "join" && { backgroundColor: COLORS.primaryOrange },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tabText,
                            { color: activeTab === "join" ? "#FFFFFF" : COLORS.creamLight },
                          ]}
                        >
                          Join
                        </Text>
                      </Pressable>
                    </View>
                  )}

                  {activeTab === "new" && !forceJoinOnly ? (
                    <View style={styles.actionContainer}>
                      <Pressable
                        onPress={handleCreateRoom}
                        disabled={isLoading}
                        style={[
                          styles.actionButton,
                          {
                            backgroundColor: COLORS.primaryOrange,
                            opacity: isLoading ? 0.5 : 1,
                          },
                        ]}
                      >
                        <Plus size={18} color="#FFFFFF" />
                        <Text style={styles.actionButtonText}>
                          {isLoading ? "Starting..." : "Start Meeting"}
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.actionContainer}>
                      <View style={styles.inputGroup}>
                        <Text style={[styles.inputLabel, { color: COLORS.creamLight }]}>
                          Room Name
                        </Text>
                        <TextInput
                          style={[styles.textInput, {
                            backgroundColor: COLORS.surface,
                            borderColor: COLORS.creamDim,
                            color: COLORS.cream,
                          }]}
                          placeholder="Paste room link or code"
                          placeholderTextColor={COLORS.creamLighter}
                          value={roomId}
                          onChangeText={handleRoomChange}
                          autoCapitalize="none"
                          autoCorrect={false}
                          returnKeyType="join"
                          onSubmitEditing={handleJoin}
                        />
                      </View>

                      <Pressable
                        onPress={handleJoin}
                        disabled={!canJoin || isLoading}
                        style={[
                          styles.actionButton,
                          {
                            backgroundColor:
                              canJoin && !isLoading
                                ? COLORS.primaryOrange
                                : COLORS.creamDim,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.actionButtonText,
                            {
                              color:
                                canJoin && !isLoading
                                  ? "#FFFFFF"
                                  : COLORS.creamLighter,
                            },
                          ]}
                        >
                          {isLoading ? "Connecting..." : "Join Meeting"}
                        </Text>
                        {!isLoading && canJoin && (
                          <ArrowRight size={18} color="#FFFFFF" />
                        )}
                      </Pressable>
                    </View>
                  )}
                </Animated.View>
              </View> {/* End two-column layout wrapper */}

            </ScrollView>

            {!forceJoinOnly && (
              <View
                style={[
                  styles.backDock,
                  { paddingBottom: Math.max(12, insets.bottom) },
                ]}
              >
                <Pressable
                  onPress={() => {
                    haptic();
                    setPhase("auth");
                  }}
                  style={styles.backButtonJoin}
                >
                  <View style={styles.backRow}>
                    <ArrowLeft size={14} color={COLORS.creamLighter} />
                    <Text style={[styles.backButtonText, { color: COLORS.creamLighter }]}>
                      back
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </DotGridBackground>
  );
}

const styles = StyleSheet.create({
  flex1: {
    flex: 1,
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  centerItems: {
    alignItems: "center",
  },
  welcomeLabel: {
    fontSize: 18,
    marginBottom: 8,
    fontWeight: "500",
    fontFamily: "PolySans-BulkyWide",
  },
  brandingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  bracket: {
    fontSize: 32,
    fontWeight: "300",
    fontFamily: "PolySans-Mono",
  },
  brandTitle: {
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: -1,
    marginHorizontal: 8,
    fontFamily: "PolySans-BulkyWide",
  },
  tagline: {
    fontSize: 14,
    textAlign: "center",
    marginBottom: 48,
    maxWidth: 500,
    lineHeight: 20,
    fontFamily: "PolySans-Regular",
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  arrowIcon: {
    color: "#FFFFFF",
    fontSize: 18,
  },
  authContent: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  authCard: {
    width: "100%",
  },
  authHeader: {
    alignItems: "center",
    marginBottom: 32,
  },
  authTitle: {
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
    fontFamily: "PolySans-BulkyWide",
  },
  authSubtitle: {
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  inputGroup: {
    gap: 12,
  },
  inputLabel: {
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  textInput: {
    width: "100%",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    fontSize: 15,
    borderWidth: 1,
    fontFamily: "PolySans-Regular",
  },
  secondaryButton: {
    width: "100%",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "500",
    fontFamily: "PolySans-Regular",
  },
  backButton: {
    marginTop: 32,
    alignItems: "center",
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  backButtonText: {
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  joinContent: {
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 20,
  },
  sectionLabel: {
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 8,
    fontFamily: "PolySans-Mono",
  },
  videoPreview: {
    aspectRatio: 16 / 9,
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
  },
  rtcView: {
    width: "100%",
    height: "100%",
  },
  noVideoContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  userAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  userInitial: {
    fontSize: 24,
    fontWeight: "700",
    fontFamily: "PolySans-BulkyWide",
  },
  nameOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  overlayText: {
    fontSize: 12,
    color: "rgba(254, 252, 217, 0.7)",
    fontFamily: "PolySans-Mono",
  },
  mediaControlsContainer: {
    position: "absolute",
    bottom: 12,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  mediaControlsPill: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: 24,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  mediaButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  mediaButtonActive: {
    backgroundColor: "#ef4444",
  },
  mediaButtonIcon: {
    fontSize: 16,
    color: "#FFFFFF",
  },
  preflightRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  preflightLabel: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    color: "rgba(254, 252, 217, 0.7)",
    fontFamily: "PolySans-Mono",
  },
  joinCard: {
    borderRadius: 16,
    padding: 20,
    backgroundColor: "rgba(20, 20, 20, 0.8)",
    borderWidth: 1,
  },
  tabContainer: {
    flexDirection: "row",
    marginBottom: 20,
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
  },
  tabText: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontWeight: "500",
    fontFamily: "PolySans-Mono",
  },
  actionContainer: {
    gap: 16,
  },
  actionButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 12,
  },
  actionButtonIcon: {
    fontSize: 18,
    color: "#FFFFFF",
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: "500",
    color: "#FFFFFF",
    fontFamily: "PolySans-Regular",
  },
  suggestionsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  suggestionPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  suggestionText: {
    fontSize: 12,
    fontFamily: "PolySans-Regular",
  },
  quickActionsRow: {
    flexDirection: "row",
    gap: 8,
  },
  quickActionButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  quickActionText: {
    fontSize: 12,
    fontFamily: "PolySans-Mono",
  },
  backButtonJoin: {
    alignItems: "center",
    marginTop: 8,
  },
  backDock: {
    borderTopWidth: 1,
    borderTopColor: "rgba(254, 252, 217, 0.06)",
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  // iPad-specific responsive styles
  joinContentTablet: {
    paddingHorizontal: 40,
    paddingVertical: 40,
    justifyContent: "center",
    flexGrow: 1,
  },
  twoColumnLayout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 32,
  },
  videoPreviewTablet: {
    aspectRatio: 16 / 10,
    borderRadius: 20,
  },
});
