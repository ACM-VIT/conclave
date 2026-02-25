import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { RTCView } from "react-native-webrtc";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated, { FadeIn, FadeInDown, FadeInUp } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
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
import { generateRoomCode } from "../utils";
import { useDeviceLayout } from "../hooks/use-device-layout";
import { ErrorSheet } from "./error-sheet";
import { GlassPill } from "./glass-pill";
import {
  Image,
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

const textLineHeight = (fontSize: number, multiplier = 1.2) =>
  Math.round(fontSize * multiplier);

type Phase = "welcome" | "auth" | "join";

const isIos = Platform.OS === "ios";

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

const appleIcon = require("../../../../assets/apple-50.png");

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
  prefillRoomId?: string;
  onRoomIdChange: (value: string) => void;
  onJoinRoom: (roomId: string, options?: { isHost?: boolean }) => void;
  onIsAdminChange?: (isAdmin: boolean) => void;
  user?: { id?: string; email?: string | null; name?: string | null } | null;
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
  hasAudioPermission: boolean;
  hasVideoPermission: boolean;
  permissionsReady: boolean;
  meetError?: MeetError | null;
  onDismissMeetError?: () => void;
  onRetryMedia?: () => void;
  onRequestMedia?: () => void;
  forceJoinOnly?: boolean;
}

export function JoinScreen({
  roomId,
  prefillRoomId,
  onRoomIdChange,
  onJoinRoom,
  onIsAdminChange,
  user,
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
  hasAudioPermission,
  hasVideoPermission,
  permissionsReady,
  meetError,
  onDismissMeetError,
  onRetryMedia,
  onRequestMedia,
  forceJoinOnly = false,
}: JoinScreenProps) {
  const { layout, isTablet, spacing, width: screenWidth } = useDeviceLayout();
  const isIpadLayout = isTablet && layout !== "compact";
  const isSignedInUser = Boolean(user && !user.id?.startsWith("guest-"));
  const [phase, setPhase] = useState<Phase>(() => {
    if (forceJoinOnly) return "join";
    if (isSignedInUser) return "join";
    if (prefillRoomId?.trim()) return "auth";
    return "welcome";
  });
  const [guestName, setGuestName] = useState("");
  const [activeTab, setActiveTab] = useState<"new" | "join">(() => {
    if (forceJoinOnly) return "join";
    if (prefillRoomId?.trim()) return "join";
    return "new";
  });
  const lastPrefillRef = useRef("");
  const [authProvider, setAuthProvider] = useState<"google" | "apple" | null>(
    null
  );
  const [isAppleAvailable, setIsAppleAvailable] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const nameInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const isAuthLoading = authProvider !== null;
  const phases = useMemo<Phase[]>(
    () => (forceJoinOnly ? ["join"] : ["welcome", "auth", "join"]),
    [forceJoinOnly]
  );
  const panResponder = useMemo(() => {
    if (phases.length <= 1) {
      return null;
    }

    const index = phases.indexOf(phase);
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        const { dx, dy } = gesture;
        return Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12;
      },
      onPanResponderRelease: (_evt, gesture) => {
        const { dx, vx } = gesture;
        if (index < 0) return;
        if (dx <= -60 && vx <= -0.2 && index < phases.length - 1) {
          setPhase(phases[index + 1]);
        } else if (dx >= 60 && vx >= 0.2 && index > 0) {
          setPhase(phases[index - 1]);
        }
      },
    });
  }, [phase, phases]);
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

  const shouldShowPermissionPrompt =
    phase === "join" &&
    Platform.OS === "android" &&
    !!onRequestMedia &&
    permissionsReady &&
    (!hasAudioPermission || !hasVideoPermission);

  const canJoin = roomId.trim().length > 0;

  const handleRoomChange = useCallback(
    (value: string) => {
      onRoomIdChange(value);
    },
    [onRoomIdChange]
  );

  useEffect(() => {
    const prefillValue = prefillRoomId?.trim() ?? "";
    if (!prefillValue || prefillValue === lastPrefillRef.current) return;
    lastPrefillRef.current = prefillValue;
    setActiveTab("join");
    if (forceJoinOnly) {
      setPhase("join");
      return;
    }
    if (isSignedInUser) {
      setPhase("join");
    } else if (phase === "welcome") {
      setPhase("auth");
    }
  }, [forceJoinOnly, isSignedInUser, phase, prefillRoomId]);

  const handleContinueAsGuest = useCallback(() => {
    if (!guestName.trim()) return;
    haptic();
    onDisplayNameInputChange(guestName.trim());
    setPhase("join");
  }, [guestName, haptic, onDisplayNameInputChange]);

  const handleNamePress = useCallback(() => {
    setIsEditingName(true);
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
  }, []);

  const handleNameBlur = useCallback(() => {
    setIsEditingName(false);
  }, []);

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
        headers: {
          "Content-Type": "application/json",
          Origin: trimmedBase,
        },
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
        const details = text
          ? `Sign in request failed: ${text}`
          : `Sign in request failed (${response.status})`;
        throw new Error(details);
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

  useEffect(() => {
    if (forceJoinOnly) return;
    if (isSignedInUser) {
      setPhase("join");
    }
  }, [forceJoinOnly, isSignedInUser]);

  if (phase === "welcome") {
    return (
      <DotGridBackground>
        <SafeAreaView style={styles.flex1} edges={["top", "bottom"]}>
          <View style={styles.flex1} {...(panResponder?.panHandlers ?? {})}>
            <ScrollView
              contentContainerStyle={styles.centerContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="never"
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
                  <Text numberOfLines={1} ellipsizeMode="clip" style={styles.primaryButtonText}>
                    LET'S GO
                  </Text>
                  <ArrowRight size={16} color="#FFFFFF" />
                </Pressable>
              </Animated.View>
            </ScrollView>
          </View>
        </SafeAreaView>
      </DotGridBackground>
    );
  }

  if (phase === "auth") {
    return (
      <DotGridBackground>
        <SafeAreaView style={styles.flex1} edges={["top", "bottom"]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.flex1}
          >
            <View style={styles.flex1} {...(panResponder?.panHandlers ?? {})}>
              <ScrollView
                style={styles.flex1}
                contentContainerStyle={[
                  styles.authContent,
                  isIpadLayout && styles.authContentTablet,
                ]}
                keyboardShouldPersistTaps="handled"
                contentInsetAdjustmentBehavior="never"
              >
                <Animated.View
                  entering={FadeInDown.duration(400)}
                  style={[styles.authCard, isIpadLayout && styles.authCardTablet]}
                >
                  <View style={styles.authHeader}>
                    <Text style={[styles.authTitle, { color: COLORS.cream }]}>
                      Join
                    </Text>
                    <Text style={[styles.authSubtitle, { color: COLORS.creamLight }]}>
                      choose how to continue
                    </Text>
                  </View>

                  <View style={styles.socialGroup}>
                  <GlassPill style={styles.socialPill}>
                    <Pressable
                      onPress={handleGoogleSignIn}
                      disabled={!googleRequest || isAuthLoading}
                      style={({ pressed }) => [
                        styles.socialButton,
                        pressed && styles.socialButtonPressed,
                        (isAuthLoading || !googleRequest) && styles.socialButtonDisabled,
                      ]}
                    >
                      <View style={styles.socialIconLeft}>
                        {authProvider === "google" ? (
                          <ActivityIndicator size="small" color={COLORS.cream} />
                        ) : (
                          <GoogleIcon size={20} />
                        )}
                      </View>
                      <Text style={styles.socialButtonText}>Continue with Google</Text>
                    </Pressable>
                  </GlassPill>

                  {Platform.OS === "ios" && isAppleAvailable ? (
                    <GlassPill style={styles.socialPill}>
                      <Pressable
                        onPress={handleAppleSignIn}
                        disabled={isAuthLoading}
                        style={({ pressed }) => [
                          styles.socialButton,
                          pressed && styles.socialButtonPressed,
                          isAuthLoading && styles.socialButtonDisabled,
                        ]}
                      >
                        <View style={styles.socialIconLeft}>
                          {authProvider === "apple" ? (
                            <ActivityIndicator size="small" color={COLORS.cream} />
                          ) : (
                            <Image
                              source={appleIcon}
                              style={styles.appleIcon}
                              accessibilityIgnoresInvertColors
                            />
                          )}
                        </View>
                        <Text style={styles.socialButtonText}>Continue with Apple</Text>
                      </Pressable>
                    </GlassPill>
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
                    <GlassPill style={styles.authInputPill}>
                      <TextInput
                        style={styles.authTextInput}
                        placeholder="Enter your name"
                        placeholderTextColor={COLORS.creamLighter}
                        value={guestName}
                        onChangeText={setGuestName}
                        autoCapitalize="words"
                        returnKeyType="done"
                        onSubmitEditing={handleContinueAsGuest}
                      />
                    </GlassPill>

                    <GlassPill style={styles.authActionPill}>
                      <Pressable
                        onPress={handleContinueAsGuest}
                        disabled={!guestName.trim()}
                        style={[
                          styles.secondaryButton,
                          !guestName.trim() && styles.secondaryButtonDisabled,
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
                    </GlassPill>
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
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </DotGridBackground>
    );
  }

  if (!isIpadLayout) {
    return (
      <DotGridBackground>
        <SafeAreaView style={styles.flex1} edges={["top", "bottom"]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.flex1}
          >
            <View style={styles.flex1} {...(panResponder?.panHandlers ?? {})}>
              {meetError ? (
                <ErrorSheet
                  visible={!!meetError}
                  meetError={meetError}
                  onDismiss={onDismissMeetError}
                  autoDismissMs={6000}
                  primaryActionLabel={onRetryMedia ? "Retry Permissions" : undefined}
                  onPrimaryAction={onRetryMedia}
                />
              ) : null}

              <View style={styles.fullPreviewWrap}>
                <View style={styles.fullPreviewFrame}>
                  {localStream && !isCameraOff ? (
                    <RTCView
                      streamURL={localStream.toURL()}
                      style={styles.rtcView}
                      mirror
                    />
                  ) : (
                    <View style={styles.noVideoContainer}>
                      <LinearGradient
                        colors={["rgba(249, 95, 74, 0.2)", "rgba(255, 0, 122, 0.1)"]}
                        style={styles.previewGradient}
                      />
                      <View style={styles.userAvatar}>
                        <View style={styles.userAvatarBorder} />
                        <Text style={[styles.userInitial, { color: COLORS.cream }]}>
                          {userInitial}
                        </Text>
                      </View>
                      {shouldShowPermissionPrompt ? (
                        <View style={styles.permissionFallback}>
                          <Text style={styles.permissionTitle}>
                            Camera and microphone access needed
                          </Text>
                          <Text style={styles.permissionText}>
                            Grant access to preview and join.
                          </Text>
                          <Pressable
                            onPress={onRequestMedia}
                            disabled={showPermissionHint}
                            style={[
                              styles.permissionButton,
                              showPermissionHint && styles.permissionButtonDisabled,
                            ]}
                          >
                            {showPermissionHint ? (
                              <ActivityIndicator size="small" color="#FFFFFF" />
                            ) : (
                              <Text style={styles.permissionButtonText}>Grant access</Text>
                            )}
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  )}

                  {isEditingName ? (
                    <View style={styles.nameOverlay}>
                      <TextInput
                        ref={nameInputRef}
                        style={styles.nameInput}
                        value={displayNameInput}
                        placeholder="Your name"
                        placeholderTextColor="rgba(254, 252, 217, 0.6)"
                        onChangeText={onDisplayNameInputChange}
                        onBlur={handleNameBlur}
                        returnKeyType="done"
                        onSubmitEditing={handleNameBlur}
                        autoCorrect={false}
                      />
                    </View>
                  ) : (
                    <Pressable onPress={handleNamePress} style={styles.nameOverlay}>
                      <Text style={styles.overlayText}>
                        {displayNameInput || "Guest"}
                      </Text>
                    </Pressable>
                  )}

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
              </View>

              <View style={styles.joinDock} pointerEvents="box-none">
                <View style={styles.joinDockInner}>
                  {!forceJoinOnly ? (
                    <GlassPill style={styles.joinDockTabs}>
                      <Pressable
                        onPress={() => {
                          haptic();
                          setActiveTab("new");
                        }}
                        style={[
                          styles.joinDockTab,
                          activeTab === "new" && styles.joinDockTabActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.joinDockTabText,
                            { color: activeTab === "new" ? "#FFFFFF" : COLORS.creamLight },
                          ]}
                        >
                          Create
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          haptic();
                          setActiveTab("join");
                        }}
                        style={[
                          styles.joinDockTab,
                          activeTab === "join" && styles.joinDockTabActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.joinDockTabText,
                            { color: activeTab === "join" ? "#FFFFFF" : COLORS.creamLight },
                          ]}
                        >
                          Join
                        </Text>
                      </Pressable>
                    </GlassPill>
                  ) : null}

                  {activeTab === "join" ? (
                    <GlassPill style={styles.joinDockAction}>
                      <View style={styles.joinDockInputRow}>
                        <TextInput
                          style={styles.joinDockInputField}
                          placeholder="Room code or link"
                          placeholderTextColor={COLORS.creamLighter}
                          value={roomId}
                          onChangeText={handleRoomChange}
                          autoCapitalize="none"
                          autoCorrect={false}
                          returnKeyType="join"
                          onSubmitEditing={handleJoin}
                        />
                        <Pressable
                          onPress={handleJoin}
                          disabled={!canJoin || isLoading}
                          style={[
                            styles.joinDockArrow,
                            (!canJoin || isLoading) && styles.joinDockButtonDisabled,
                          ]}
                        >
                          <ArrowRight size={18} color="#FFFFFF" />
                        </Pressable>
                      </View>
                    </GlassPill>
                  ) : (
                    <GlassPill style={styles.joinDockAction}>
                      <Pressable
                        onPress={handleCreateRoom}
                        disabled={isLoading}
                        style={[
                          styles.joinDockButton,
                          isLoading && styles.joinDockButtonDisabled,
                        ]}
                      >
                        <Text style={styles.joinDockButtonText}>
                          {isLoading ? "Starting..." : "Start Meeting"}
                        </Text>
                      </Pressable>
                    </GlassPill>
                  )}
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </DotGridBackground>
    );
  }

  // iPad-specific layout calculations
  const maxContentWidth = isIpadLayout ? 1200 : undefined;
  const videoPreviewFlex = isIpadLayout ? 1.15 : undefined;
  const joinCardFlex = isIpadLayout ? 0.85 : undefined;

  return (
    <DotGridBackground>
      <SafeAreaView style={styles.flex1} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex1}
        >
          <View style={styles.flex1} {...(panResponder?.panHandlers ?? {})}>
            <ScrollView
              style={styles.flex1}
              contentContainerStyle={[
                styles.joinContent,
                isIpadLayout && styles.joinContentTablet,
                isIpadLayout && { maxWidth: maxContentWidth, alignSelf: "center" as const, width: "100%" as const },
              ]}
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="never"
            >
              <View style={styles.joinContentInner}>
                {meetError ? (
                  <ErrorSheet
                    visible={!!meetError}
                    meetError={meetError}
                    onDismiss={onDismissMeetError}
                    autoDismissMs={6000}
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
                    <View
                      style={[
                        styles.videoPreview,
                        {
                          backgroundColor: isIos
                            ? "rgba(13, 14, 13, 0.35)"
                            : "#0d0e0d",
                          borderColor: "rgba(254, 252, 217, 0.1)",
                        },
                        isIpadLayout && styles.videoPreviewTablet,
                      ]}
                    >
                      {localStream && !isCameraOff ? (
                        <RTCView
                          streamURL={localStream.toURL()}
                          style={styles.rtcView}
                          mirror
                        />
                      ) : (
                        <View style={styles.noVideoContainer}>
                          <LinearGradient
                            colors={["rgba(249, 95, 74, 0.2)", "rgba(255, 0, 122, 0.1)"]}
                            style={styles.previewGradient}
                          />
                          <View style={styles.userAvatar}>
                            <View style={styles.userAvatarBorder} />
                            <Text style={[styles.userInitial, { color: COLORS.cream }]}>
                              {userInitial}
                            </Text>
                          </View>
                          {shouldShowPermissionPrompt ? (
                            <View style={styles.permissionFallback}>
                              <Text style={styles.permissionTitle}>
                                Camera and microphone access needed
                              </Text>
                              <Text style={styles.permissionText}>
                                Grant access to preview and join.
                              </Text>
                              <Pressable
                                onPress={onRequestMedia}
                                disabled={showPermissionHint}
                                style={[
                                  styles.permissionButton,
                                  showPermissionHint && styles.permissionButtonDisabled,
                                ]}
                              >
                                {showPermissionHint ? (
                                  <ActivityIndicator size="small" color="#FFFFFF" />
                                ) : (
                                  <Text style={styles.permissionButtonText}>
                                    Grant access
                                  </Text>
                                )}
                              </Pressable>
                            </View>
                          ) : null}
                        </View>
                      )}

                  {isEditingName ? (
                    <View style={styles.nameOverlay}>
                      <TextInput
                        ref={nameInputRef}
                        style={styles.nameInput}
                        value={displayNameInput}
                        placeholder="Your name"
                        placeholderTextColor="rgba(254, 252, 217, 0.6)"
                        onChangeText={onDisplayNameInputChange}
                        onBlur={handleNameBlur}
                        returnKeyType="done"
                        onSubmitEditing={handleNameBlur}
                        autoCorrect={false}
                      />
                    </View>
                  ) : (
                    <Pressable onPress={handleNamePress} style={styles.nameOverlay}>
                      <Text style={styles.overlayText}>
                        {displayNameInput || "Guest"}
                      </Text>
                    </Pressable>
                  )}

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
                  </Animated.View>

                  <Animated.View
                    entering={FadeInUp.delay(100).duration(400)}
                    style={[
                      isIpadLayout && { flex: joinCardFlex, marginTop: 0, marginLeft: spacing.lg },
                    ]}
                  >
                    <View
                      style={[
                        styles.joinCard,
                        { borderColor: COLORS.creamDim },
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

                    {!forceJoinOnly && (
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
                    )}
                    </View>
                  </Animated.View>
                </View>
              </View>
            </ScrollView>
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
  fullPreviewWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 140,
  },
  fullPreviewFrame: {
    flex: 1,
    borderRadius: 28,
    overflow: "hidden",
    backgroundColor: "#0d0e0d",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.1)",
  },
  permissionFallback: {
    marginTop: 16,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 6,
  },
  permissionTitle: {
    fontSize: 13,
    lineHeight: textLineHeight(13, 1.2),
    fontWeight: "600",
    color: COLORS.cream,
    fontFamily: "PolySans-Regular",
    textAlign: "center",
    maxWidth: "100%",
  },
  permissionText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.35),
    color: COLORS.creamLight,
    fontFamily: "PolySans-Regular",
    textAlign: "center",
    maxWidth: "100%",
  },
  permissionButton: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(249, 95, 74, 0.9)",
  },
  permissionButtonDisabled: {
    opacity: 0.7,
  },
  permissionButtonText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.2),
    color: "#FFFFFF",
    fontFamily: "PolySans-Regular",
    letterSpacing: 0.2,
  },
  preflightRowOverlay: {
    marginTop: 0,
  },
  joinDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  joinDockInner: {
    gap: 12,
  },
  joinDockTabs: {
    flexDirection: "row",
    padding: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
    backgroundColor: isIos ? "rgba(12, 12, 12, 0.4)" : "rgba(12, 12, 12, 0.8)",
  },
  joinDockTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
  },
  joinDockTabActive: {
    backgroundColor: "rgba(249, 95, 74, 0.85)",
  },
  joinDockTabText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.2),
    letterSpacing: 1,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
    textAlign: "center",
    flexShrink: 1,
  },
  joinDockInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: "100%",
    paddingHorizontal: 14,
    minWidth: 0,
  },
  joinDockInputField: {
    flex: 1,
    minWidth: 0,
    color: COLORS.cream,
    fontSize: 14,
    fontFamily: "PolySans-Regular",
    includeFontPadding: false,
    paddingRight: 4,
  },
  joinDockArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 95, 74, 0.85)",
  },
  joinDockAction: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
    backgroundColor: isIos ? "rgba(20, 20, 20, 0.35)" : "rgba(20, 20, 20, 0.85)",
    height: 52,
  },
  joinDockButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: "100%",
    paddingHorizontal: 18,
    borderRadius: 999,
  },
  joinDockButtonDisabled: {
    opacity: 0.6,
  },
  joinDockButtonText: {
    fontSize: 14,
    lineHeight: textLineHeight(14, 1.25),
    fontWeight: "600",
    color: "#FFFFFF",
    fontFamily: "PolySans-Regular",
    flexShrink: 1,
    textAlign: "center",
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
    fontSize: 14,
    lineHeight: textLineHeight(18, 1.2),
    marginBottom: 8,
    fontWeight: "500",
    textAlign: "center",
    fontFamily: "PolySans-BulkyWide",
  },
  brandingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  bracket: {
    fontSize: 32,
    lineHeight: textLineHeight(32, 1.15),
    fontWeight: "300",
    fontFamily: "PolySans-Mono",
  },
  brandTitle: {
    fontSize: 40,
    lineHeight: textLineHeight(40, 1.12),
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
    lineHeight: textLineHeight(11, 1.3),
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
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  authContentTablet: {
    paddingHorizontal: 48,
    paddingVertical: 40,
    alignItems: "center",
  },
  authCard: {
    width: "100%",
    alignSelf: "center",
    maxWidth: 420,
    padding: 0,
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  authCardTablet: {
    maxWidth: 520,
    padding: 0,
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  authHeader: {
    alignItems: "center",
    marginBottom: 32,
  },
  authTitle: {
    fontSize: 28,
    lineHeight: textLineHeight(28, 1.2),
    fontWeight: "700",
    marginBottom: 8,
    fontFamily: "PolySans-BulkyWide",
  },
  authSubtitle: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  socialGroup: {
    gap: 12,
    marginBottom: 20,
  },
  socialPill: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 360,
    height: 54,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
    backgroundColor: isIos ? "rgba(20, 20, 20, 0.35)" : "rgba(20, 20, 20, 0.85)",
  },
  socialButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    height: "100%",
    paddingVertical: 0,
    paddingHorizontal: 18,
    borderRadius: 999,
    justifyContent: "center",
  },
  socialButtonPressed: {
    opacity: 0.85,
  },
  socialButtonDisabled: {
    opacity: 0.5,
  },
  socialIconLeft: {
    position: "absolute",
    left: 80,
    width: 24,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  appleIcon: {
    width: 20,
    height: 20,
    objectFit: "contain",
  },
  socialIconText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
    fontWeight: "600",
    color: "#FEFCD9",
    fontFamily: "PolySans-Mono",
  },
  socialButtonText: {
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: -0.2,
    fontFamily: "PolySans-Regular",
    color: COLORS.cream,
    lineHeight: textLineHeight(13, 1.25),
    includeFontPadding: false,
    paddingLeft: 50,
    width: "100%",
    textAlign: "center",
    marginTop: 5,
    paddingTop: 13,
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
    lineHeight: textLineHeight(11, 1.3),
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  inputGroup: {
    gap: 12,
  },
  authInputPill: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 360,
    height: 54,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
    backgroundColor: isIos ? "rgba(20, 20, 20, 0.35)" : "rgba(20, 20, 20, 0.85)",
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  authTextInput: {
    height: "100%",
    color: COLORS.cream,
    fontSize: 14,
    fontFamily: "PolySans-Regular",
    includeFontPadding: false,
    paddingVertical: 0,
  },
  authActionPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
    backgroundColor: isIos ? "rgba(20, 20, 20, 0.35)" : "rgba(20, 20, 20, 0.85)",
  },
  inputLabel: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
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
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: "center",
    backgroundColor: COLORS.primaryOrange,
  },
  secondaryButtonDisabled: {
    backgroundColor: "rgba(254, 252, 217, 0.1)",
  },
  secondaryButtonText: {
    fontSize: 15,
    lineHeight: textLineHeight(15, 1.25),
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
    lineHeight: textLineHeight(12, 1.25),
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  joinContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 0,
  },
  joinContentInner: {
    gap: 20,
  },
  sectionLabel: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
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
  previewGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  userAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 95, 74, 0.15)",
    position: "relative",
  },
  userAvatarBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.2)",
  },
  userInitial: {
    fontSize: 24,
    lineHeight: textLineHeight(24, 1.2),
    fontWeight: "700",
    fontFamily: "PolySans-BulkyWide",
  },
  nameOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.2)",
  },
  overlayText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
    color: "rgba(254, 252, 217, 0.9)",
    fontFamily: "PolySans-Mono",
  },
  nameInput: {
    minWidth: 96,
    color: "rgba(254, 252, 217, 0.95)",
    fontSize: 12,
    fontFamily: "PolySans-Mono",
    includeFontPadding: false,
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
    lineHeight: textLineHeight(12, 1.25),
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
    borderColor: "rgba(254, 252, 217, 0.1)",
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    lineHeight: textLineHeight(12, 1.25),
    color: "rgba(254, 252, 217, 0.7)",
    fontFamily: "PolySans-Mono",
  },
  joinCard: {
    borderRadius: 16,
    padding: 20,
    backgroundColor: isIos
      ? "rgba(20, 20, 20, 0.35)"
      : "rgba(20, 20, 20, 0.8)",
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
    lineHeight: textLineHeight(12, 1.25),
    letterSpacing: 1,
    textTransform: "uppercase",
    fontWeight: "500",
    fontFamily: "PolySans-Mono",
    textAlign: "center",
    flexShrink: 1,
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
    lineHeight: textLineHeight(15, 1.25),
    fontWeight: "500",
    color: "#FFFFFF",
    fontFamily: "PolySans-Regular",
    flexShrink: 1,
    textAlign: "center",
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
    lineHeight: textLineHeight(12, 1.25),
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
    lineHeight: textLineHeight(12, 1.25),
    fontFamily: "PolySans-Mono",
  },
  backButtonJoin: {
    alignItems: "center",
    marginTop: 16,
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
