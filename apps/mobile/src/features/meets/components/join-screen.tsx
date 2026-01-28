import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { RTCView } from "react-native-webrtc";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import Svg, { Path } from "react-native-svg";
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

const GoogleIcon = ({ size = 18 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <Path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <Path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    />
    <Path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </Svg>
);

const AppleIcon = ({ size = 18, color = COLORS.cream }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      fill={color}
      d="M16.365 1.43c0 1.14-.462 2.06-1.12 2.78-.74.8-1.94 1.41-3.06 1.32-.14-1.1.35-2.22 1.05-2.98.78-.82 2.12-1.45 3.13-1.12ZM20.39 17.3c-.33.77-.49 1.11-.91 1.79-.58.94-1.4 2.11-2.42 2.12-.91.01-1.14-.6-2.38-.6s-1.5.59-2.41.61c-1.02.01-1.79-1.08-2.37-2.02-1.64-2.65-1.82-5.75-.8-7.33.72-1.11 1.87-1.77 2.95-1.77.92 0 1.5.63 2.38.63.85 0 1.38-.64 2.37-.64 1.02 0 2.1.56 2.82 1.52-2.48 1.36-2.08 4.93.77 5.69Z"
    />
  </Svg>
);

const authBaseUrl =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.EXPO_PUBLIC_API_URL ||
  process.env.EXPO_PUBLIC_SFU_BASE_URL ||
  "";

const googleClientConfig = {
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  expoClientId: process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID,
  scopes: ["openid", "profile", "email"],
};

WebBrowser.maybeCompleteAuthSession();

interface JoinScreenProps {
  roomId: string;
  onRoomIdChange: (value: string) => void;
  onJoinRoom: (roomId: string, options?: { isHost?: boolean }) => void;
  onIsAdminChange?: (isAdmin: boolean) => void;
  onUserChange?: (
    user: { id?: string; email?: string | null; name?: string | null } | null
  ) => void;
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
  onUserChange,
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
  const [authProvider, setAuthProvider] = useState<"google" | "apple" | null>(
    null
  );
  const [isAppleAvailable, setIsAppleAvailable] = useState(false);
  const isAuthLoading = authProvider !== null;
  const googleRedirectUri = useMemo(() => {
    const clientId = Platform.select({
      ios: googleClientConfig.iosClientId,
      android: googleClientConfig.androidClientId,
    });
    if (!clientId) return undefined;
    const prefix = clientId.replace(".apps.googleusercontent.com", "");
    return `com.googleusercontent.apps.${prefix}:/oauthredirect`;
  }, [googleClientConfig.androidClientId, googleClientConfig.iosClientId]);

  const [googleRequest, googleResponse, googlePromptAsync] =
    Google.useAuthRequest(
      {
        ...googleClientConfig,
        ...(googleRedirectUri ? { redirectUri: googleRedirectUri } : {}),
      },
      googleRedirectUri ? { native: googleRedirectUri } : {}
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

  const completeSocialSignIn = useCallback(
    async (provider: "google" | "apple", idToken?: string, nonce?: string, accessToken?: string) => {
      const trimmedBase = authBaseUrl.replace(/\/$/, "");
      if (!trimmedBase) {
        throw new Error("Missing EXPO_PUBLIC_APP_URL or EXPO_PUBLIC_API_URL");
      }
      if (!idToken) {
        throw new Error("Missing identity token");
      }
      const response = await fetch(`${trimmedBase}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          callbackURL: trimmedBase,
          idToken: {
            token: idToken,
            nonce,
            accessToken,
          },
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || "Sign in request failed");
      }
      const data = (await response.json().catch(() => null)) as
        | {
            user?: { id?: string; email?: string | null; name?: string | null };
          }
        | null;
      if (data?.user) {
        onUserChange?.(data.user);
        if (!displayNameInput.trim()) {
          const resolvedName = data.user.name || data.user.email || "User";
          onDisplayNameInputChange(resolvedName);
        }
        setPhase("join");
      }
    },
    [displayNameInput, onDisplayNameInputChange, onUserChange]
  );

  const handleGoogleSignIn = useCallback(async () => {
    if (isAuthLoading) return;
    haptic();
    setAuthProvider("google");
    try {
      await googlePromptAsync();
    } catch (error) {
      console.log("[JoinScreen] Google sign-in error", error);
      setAuthProvider(null);
    }
  }, [googlePromptAsync, haptic, isAuthLoading]);

  const handleAppleSignIn = useCallback(async () => {
    if (isAuthLoading) return;
    haptic();
    setAuthProvider("apple");
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      await completeSocialSignIn(
        "apple",
        credential.identityToken ?? undefined
      );
    } catch (error) {
      console.log("[JoinScreen] Apple sign-in error", error);
    } finally {
      setAuthProvider(null);
    }
  }, [completeSocialSignIn, haptic, isAuthLoading]);

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
    if (Platform.OS !== "ios") return;
    AppleAuthentication.isAvailableAsync()
      .then((available) => setIsAppleAvailable(available))
      .catch(() => setIsAppleAvailable(false));
  }, []);

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type !== "success") {
      if (authProvider === "google") {
        setAuthProvider(null);
      }
      return;
    }
    const idToken =
      googleResponse.authentication?.idToken ||
      (googleResponse.params as { id_token?: string } | undefined)?.id_token;
    const accessToken =
      googleResponse.authentication?.accessToken ||
      (googleResponse.params as { access_token?: string } | undefined)
        ?.access_token;
    completeSocialSignIn("google", idToken, undefined, accessToken)
      .catch((error) => {
        console.log("[JoinScreen] Google sign-in error", error);
      })
      .finally(() => {
        setAuthProvider(null);
      });
  }, [authProvider, completeSocialSignIn, googleResponse]);

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

                <View style={styles.socialGroup}>
                  <Pressable
                    onPress={handleGoogleSignIn}
                    disabled={!googleRequest || isAuthLoading}
                    style={[
                      styles.socialButton,
                      { borderColor: COLORS.creamDim },
                      (isAuthLoading || !googleRequest) && styles.socialButtonDisabled,
                    ]}
                  >
                    <View style={[styles.socialIcon, { backgroundColor: "#ffffff" }]}>
                      <GoogleIcon size={16} />
                    </View>
                    <Text style={[styles.socialButtonText, { color: COLORS.cream }]}>
                      Continue with Google
                    </Text>
                    {authProvider === "google" && (
                      <ActivityIndicator size="small" color={COLORS.cream} />
                    )}
                  </Pressable>

                  {Platform.OS === "ios" && isAppleAvailable ? (
                    <Pressable
                      onPress={handleAppleSignIn}
                      disabled={isAuthLoading}
                      style={[
                        styles.socialButton,
                        { borderColor: COLORS.creamDim, backgroundColor: "#111111" },
                        isAuthLoading && styles.socialButtonDisabled,
                      ]}
                    >
                      <View style={[styles.socialIcon, { backgroundColor: "#1a1a1a" }]}>
                        <AppleIcon size={16} />
                      </View>
                      <Text style={[styles.socialButtonText, { color: COLORS.cream }]}>
                        Continue with Apple
                      </Text>
                      {authProvider === "apple" && (
                        <ActivityIndicator size="small" color={COLORS.cream} />
                      )}
                    </Pressable>
                  ) : null}
                </View>

                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: COLORS.creamDim }]} />
                  <Text style={[styles.dividerText, { color: COLORS.creamLighter }]}>
                    or
                  </Text>
                  <View style={[styles.dividerLine, { backgroundColor: COLORS.creamDim }]} />
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
              <View style={styles.joinContentInner}>
                {meetError ? (
                  <ErrorBanner
                    meetError={meetError}
                    onDismiss={onDismissMeetError}
                    primaryActionLabel={onRetryMedia ? "Retry Permissions" : undefined}
                    onPrimaryAction={onRetryMedia}
                  />
                ) : null}

                <View style={isIpadLayout ? styles.twoColumnLayout : undefined}>
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
                </View>
              </View>
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
  socialGroup: {
    gap: 12,
    marginBottom: 20,
  },
  socialButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: "#1a1a1a",
  },
  socialButtonDisabled: {
    opacity: 0.6,
  },
  socialIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.2)",
  },
  socialIconText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#FEFCD9",
    fontFamily: "PolySans-Mono",
  },
  socialButtonText: {
    fontSize: 14,
    fontWeight: "500",
    flex: 1,
    fontFamily: "PolySans-Regular",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 11,
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
  },
  joinContentInner: {
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
