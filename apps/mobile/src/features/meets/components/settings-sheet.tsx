import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Hand,
  Lock,
  Mic,
  Radio,
  ShieldCheck,
  Unlock,
  User,
  Volume2,
} from "lucide-react-native";
import { mediaDevices } from "react-native-webrtc";
import { useApps } from "@conclave/apps-sdk";
import { Pressable, ScrollView, Text, TextInput, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../types";

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface EnumeratedMediaDevice {
  kind: string;
  deviceId: string;
  label?: string;
}

interface SettingsSheetProps {
  visible: boolean;
  isHandRaised: boolean;
  isRoomLocked: boolean;
  isNoGuests: boolean;
  isChatLocked: boolean;
  isTtsDisabled: boolean;
  isDmEnabled: boolean;
  isAdmin?: boolean;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  onOpenDisplayName?: () => void;
  onToggleHandRaised: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onToggleNoGuests?: (noGuests: boolean) => void;
  onToggleChatLock?: (locked: boolean) => void;
  onToggleTtsDisabled?: (disabled: boolean) => void;
  onToggleDmEnabled?: (enabled: boolean) => void;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  meetingRequiresInviteCode?: boolean;
  onGetMeetingConfig?: () => Promise<MeetingConfigSnapshot | null>;
  onUpdateMeetingConfig?: (
    update: MeetingUpdateRequest
  ) => Promise<MeetingConfigSnapshot | null>;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarLink?: string | null;
  onSetWebinarLink?: (link: string | null) => void;
  onGetWebinarConfig?: () => Promise<WebinarConfigSnapshot | null>;
  onUpdateWebinarConfig?: (
    update: WebinarUpdateRequest
  ) => Promise<WebinarConfigSnapshot | null>;
  onGenerateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onRotateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onClose: () => void;
}

const ACCENT = {
  neutral: {
    fg: SHEET_COLORS.textMuted,
    bg: "rgba(254, 252, 217, 0.04)",
    bd: SHEET_COLORS.border,
  },
  coral: {
    fg: "rgba(249, 95, 74, 0.95)",
    bg: "rgba(249, 95, 74, 0.16)",
    bd: "rgba(249, 95, 74, 0.5)",
  },
  amber: {
    fg: "rgba(251, 185, 36, 0.95)",
    bg: "rgba(251, 185, 36, 0.16)",
    bd: "rgba(251, 185, 36, 0.5)",
  },
  blue: {
    fg: "rgba(96, 165, 250, 0.95)",
    bg: "rgba(96, 165, 250, 0.16)",
    bd: "rgba(96, 165, 250, 0.45)",
  },
  green: {
    fg: "rgba(52, 211, 153, 0.95)",
    bg: "rgba(52, 211, 153, 0.16)",
    bd: "rgba(52, 211, 153, 0.45)",
  },
} as const;

type Accent = keyof typeof ACCENT;

function SectionLabel({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <View style={styles.sectionLabelRow}>
      {icon}
      <Text style={styles.sectionLabelText}>{label}</Text>
    </View>
  );
}

interface SettingRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  active?: boolean;
  accent?: Accent;
  onPress?: () => void;
  disabled?: boolean;
  showChevron?: boolean;
}

function SettingRow({
  title,
  subtitle,
  value,
  active = false,
  accent = "neutral",
  onPress,
  disabled = false,
  showChevron = false,
}: SettingRowProps) {
  const ac = ACCENT[accent];
  const isDisabled = disabled || !onPress;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.row,
        active ? { borderColor: ac.bd, backgroundColor: ac.bg } : null,
        isDisabled ? styles.rowDisabled : null,
      ]}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {value ? (
          <Text style={[styles.rowValue, active ? { color: ac.fg, fontWeight: "600" } : null]}>
            {value}
          </Text>
        ) : null}
        {showChevron ? (
          <ChevronRight size={16} color={SHEET_COLORS.textFaint} strokeWidth={2.2} />
        ) : null}
      </View>
    </Pressable>
  );
}

function DeviceRow({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.row,
        selected ? styles.rowSelected : null,
        disabled ? styles.rowDisabled : null,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
    >
      <Text numberOfLines={1} style={[styles.rowTitle, selected ? styles.rowTitleSelected : null]}>
        {label}
      </Text>
      {selected ? <Check size={14} color={SHEET_COLORS.text} strokeWidth={2.2} /> : null}
    </Pressable>
  );
}

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "danger";
}

function ActionButton({
  label,
  onPress,
  disabled,
  variant = "default",
}: ActionButtonProps) {
  const variantStyle =
    variant === "primary"
      ? styles.actionPrimary
      : variant === "danger"
        ? styles.actionDanger
        : styles.actionDefault;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.actionButton, variantStyle, disabled ? styles.rowDisabled : null]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

export function SettingsSheet({
  visible,
  isHandRaised,
  isRoomLocked,
  isNoGuests,
  isChatLocked,
  isTtsDisabled,
  isDmEnabled,
  isAdmin = false,
  selectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  onOpenDisplayName,
  onToggleHandRaised,
  onToggleRoomLock,
  onToggleNoGuests,
  onToggleChatLock,
  onToggleTtsDisabled,
  onToggleDmEnabled,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  meetingRequiresInviteCode = false,
  onGetMeetingConfig,
  onUpdateMeetingConfig,
  webinarConfig,
  webinarLink,
  onSetWebinarLink,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
  onClose,
}: SettingsSheetProps) {
  const { state: appsState, openApp, closeApp } = useApps();
  const isWhiteboardActive = appsState.activeAppId === "whiteboard";
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceOption[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceOption[]>([]);
  const [isLoadingAudioDevices, setIsLoadingAudioDevices] = useState(false);
  const [audioDevicesError, setAudioDevicesError] = useState<string | null>(null);

  const [webinarExpanded, setWebinarExpanded] = useState(false);
  const [meetingInviteCodeInput, setMeetingInviteCodeInput] = useState("");
  const [meetingNotice, setMeetingNotice] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [isMeetingWorking, setIsMeetingWorking] = useState(false);
  const [webinarInviteCodeInput, setWebinarInviteCodeInput] = useState("");
  const [webinarCapInput, setWebinarCapInput] = useState(
    String(webinarConfig?.maxAttendees ?? 500)
  );
  const [webinarNotice, setWebinarNotice] = useState<string | null>(null);
  const [webinarError, setWebinarError] = useState<string | null>(null);
  const [isWebinarWorking, setIsWebinarWorking] = useState(false);

  const speakerRouteOptions = useMemo<MediaDeviceOption[]>(
    () => [
      { deviceId: "route:auto", label: "Automatic" },
      { deviceId: "route:speaker", label: "Speaker" },
      { deviceId: "route:earpiece", label: "Earpiece" },
    ],
    []
  );

  const availableAudioOutputDevices =
    audioOutputDevices.length > 0 ? audioOutputDevices : speakerRouteOptions;

  const selectedAudioInputId = audioInputDevices.some(
    (device) => device.deviceId === selectedAudioInputDeviceId
  )
    ? selectedAudioInputDeviceId
    : audioInputDevices[0]?.deviceId;

  const selectedAudioOutputId = availableAudioOutputDevices.some(
    (device) => device.deviceId === selectedAudioOutputDeviceId
  )
    ? selectedAudioOutputDeviceId
    : availableAudioOutputDevices[0]?.deviceId;

  const trigger = useCallback((action: () => void) => {
    Haptics.selectionAsync().catch(() => { });
    action();
  }, []);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const fetchAudioDevices = useCallback(async () => {
    if (!mediaDevices?.enumerateDevices) {
      setAudioDevicesError("Device selection is not supported on this device.");
      setAudioInputDevices([]);
      setAudioOutputDevices([]);
      return;
    }

    setIsLoadingAudioDevices(true);
    setAudioDevicesError(null);

    try {
      const devices = (await mediaDevices.enumerateDevices()) as
        | EnumeratedMediaDevice[]
        | null
        | undefined;

      if (!Array.isArray(devices)) {
        setAudioInputDevices([]);
        setAudioOutputDevices([]);
        return;
      }

      const nextAudioInputDevices = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }));

      const nextAudioOutputDevices = devices
        .filter((device) => device.kind === "audiooutput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Speaker ${index + 1}`,
        }));

      setAudioInputDevices(nextAudioInputDevices);
      setAudioOutputDevices(nextAudioOutputDevices);
    } catch {
      setAudioDevicesError("Unable to load audio devices.");
      setAudioInputDevices([]);
      setAudioOutputDevices([]);
    } finally {
      setIsLoadingAudioDevices(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      hasPresented.current = true;
      void sheetRef.current?.present(0);
      void fetchAudioDevices();
    } else if (hasPresented.current) {
      void sheetRef.current?.dismiss();
    }
  }, [fetchAudioDevices, visible]);

  useEffect(() => {
    setWebinarCapInput(String(webinarConfig?.maxAttendees ?? 500));
  }, [webinarConfig?.maxAttendees]);

  useEffect(() => {
    if (!visible || !isAdmin) return;
    void onGetMeetingConfig?.();
    void onGetWebinarConfig?.();
  }, [isAdmin, onGetMeetingConfig, onGetWebinarConfig, visible]);

  useEffect(() => {
    return () => {
      if (hasPresented.current) {
        void sheetRef.current?.dismiss();
      }
    };
  }, []);

  useEffect(() => {
    const rtcMediaDevices = mediaDevices as typeof mediaDevices & {
      addEventListener?: (type: "devicechange", listener: () => void) => void;
      removeEventListener?: (
        type: "devicechange",
        listener: () => void
      ) => void;
    };

    if (
      !rtcMediaDevices.addEventListener ||
      !rtcMediaDevices.removeEventListener
    ) {
      return;
    }

    const handleDeviceChange = () => {
      if (!visible) return;
      void fetchAudioDevices();
    };

    rtcMediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      rtcMediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, [fetchAudioDevices, visible]);

  const runWebinarTask = useCallback(
    async (
      task: () => Promise<void>,
      options?: { successMessage?: string; clearInviteInput?: boolean }
    ) => {
      setWebinarError(null);
      setWebinarNotice(null);
      setIsWebinarWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setWebinarInviteCodeInput("");
        }
        if (options?.successMessage) {
          setWebinarNotice(options.successMessage);
        }
      } catch (error) {
        setWebinarError(
          error instanceof Error ? error.message : "Webinar update failed."
        );
      } finally {
        setIsWebinarWorking(false);
      }
    },
    []
  );

  const runMeetingTask = useCallback(
    async (
      task: () => Promise<void>,
      options?: { successMessage?: string; clearInviteInput?: boolean }
    ) => {
      setMeetingError(null);
      setMeetingNotice(null);
      setIsMeetingWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setMeetingInviteCodeInput("");
        }
        if (options?.successMessage) {
          setMeetingNotice(options.successMessage);
        }
      } catch (error) {
        setMeetingError(
          error instanceof Error ? error.message : "Meeting update failed."
        );
      } finally {
        setIsMeetingWorking(false);
      }
    },
    []
  );

  const parsedWebinarCap = Number.parseInt(webinarCapInput, 10);
  const webinarCapValue = Number.isFinite(parsedWebinarCap)
    ? Math.max(1, Math.min(5000, parsedWebinarCap))
    : null;
  const webinarEnabled = Boolean(webinarConfig?.enabled);
  const webinarPublicAccess = Boolean(webinarConfig?.publicAccess);
  const webinarLocked = Boolean(webinarConfig?.locked);
  const webinarRequiresInviteCode = Boolean(webinarConfig?.requiresInviteCode);

  const copyWebinarLink = useCallback(async (link: string) => {
    if (!link.trim()) {
      throw new Error("No webinar link available.");
    }
    await Clipboard.setStringAsync(link);
  }, []);

  return (
    <TrueSheet
      ref={sheetRef}
      detents={[0.6, 1]}
      scrollable
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <ScrollView
        contentContainerStyle={styles.sheetContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>Settings</Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.quickActionsRow}>
          <Pressable
            onPress={() => trigger(onToggleHandRaised)}
            style={({ pressed }) => [
              styles.quickActionButton,
              isHandRaised ? styles.quickActionActiveAmber : null,
              pressed && styles.quickActionPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={isHandRaised ? "Lower hand" : "Raise hand"}
          >
            <Hand
              size={18}
              color={isHandRaised ? ACCENT.amber.fg : SHEET_COLORS.textMuted}
              strokeWidth={2}
            />
          </Pressable>

          {isAdmin && onToggleRoomLock ? (
            <Pressable
              onPress={() => trigger(() => onToggleRoomLock(!isRoomLocked))}
              style={({ pressed }) => [
                styles.quickActionButton,
                isRoomLocked ? styles.quickActionActiveBlue : null,
                pressed && styles.quickActionPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isRoomLocked ? "Unlock room" : "Lock room"}
            >
              {isRoomLocked ? (
                <Lock
                  size={18}
                  color={ACCENT.blue.fg}
                  strokeWidth={2}
                />
              ) : (
                <Unlock
                  size={18}
                  color={SHEET_COLORS.textMuted}
                  strokeWidth={2}
                />
              )}
            </Pressable>
          ) : null}

          <Pressable
            onPress={onOpenDisplayName ? () => trigger(onOpenDisplayName) : undefined}
            disabled={!onOpenDisplayName}
            style={({ pressed }) => [
              styles.quickActionButton,
              !onOpenDisplayName ? styles.rowDisabled : null,
              pressed && onOpenDisplayName && styles.quickActionPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Change display name"
          >
            <User size={18} color={SHEET_COLORS.textMuted} strokeWidth={2} />
          </Pressable>
        </View>

        {isAdmin ? (
          <>
            <SectionLabel
              label="Host controls"
              icon={<ShieldCheck size={12} color={SHEET_COLORS.textMuted} strokeWidth={2} />}
            />
            <View style={styles.listContent}>
              <SettingRow
                title="Whiteboard"
                subtitle="Shared canvas for participants"
                value={isWhiteboardActive ? "Open" : "Off"}
                active={isWhiteboardActive}
                onPress={() =>
                  trigger(() => {
                    if (isWhiteboardActive) closeApp();
                    else openApp("whiteboard");
                  })
                }
              />
              <SettingRow
                title="Block guests"
                subtitle="Only invited users can join"
                value={isNoGuests ? "Blocked" : "Allow"}
                active={isNoGuests}
                accent="amber"
                onPress={onToggleNoGuests ? () => trigger(() => onToggleNoGuests(!isNoGuests)) : undefined}
                disabled={!onToggleNoGuests}
              />
              <SettingRow
                title="Lock chat"
                subtitle="Stop attendees from sending messages"
                value={isChatLocked ? "Locked" : "Open"}
                active={isChatLocked}
                accent="blue"
                onPress={onToggleChatLock ? () => trigger(() => onToggleChatLock(!isChatLocked)) : undefined}
                disabled={!onToggleChatLock}
              />
              <SettingRow
                title="Mute TTS"
                subtitle="Disable voice playback"
                value={isTtsDisabled ? "Muted" : "On"}
                active={isTtsDisabled}
                accent="coral"
                onPress={
                  onToggleTtsDisabled
                    ? () => trigger(() => onToggleTtsDisabled(!isTtsDisabled))
                    : undefined
                }
                disabled={!onToggleTtsDisabled}
              />
              <SettingRow
                title="Direct messages"
                subtitle="Allow private @messages"
                value={isDmEnabled ? "Enabled" : "Disabled"}
                active={!isDmEnabled}
                accent="amber"
                onPress={
                  onToggleDmEnabled
                    ? () => trigger(() => onToggleDmEnabled(!isDmEnabled))
                    : undefined
                }
                disabled={!onToggleDmEnabled}
              />
            </View>

            <View style={styles.fieldCard}>
              <Text style={styles.fieldHeaderText}>Meeting invite code</Text>
              <View style={styles.fieldRow}>
                <TextInput
                  value={meetingInviteCodeInput}
                  onChangeText={setMeetingInviteCodeInput}
                  placeholder="Invite code"
                  placeholderTextColor={SHEET_COLORS.textFaint}
                  style={styles.input}
                />
                <ActionButton
                  label="Save"
                  variant="primary"
                  onPress={() =>
                    trigger(() => {
                      void runMeetingTask(
                        async () => {
                          if (!onUpdateMeetingConfig) {
                            throw new Error("Meeting controls unavailable.");
                          }
                          const code = meetingInviteCodeInput.trim();
                          if (!code) {
                            throw new Error("Enter an invite code.");
                          }
                          const next = await onUpdateMeetingConfig({
                            inviteCode: code,
                          });
                          if (!next) {
                            throw new Error("Meeting update rejected.");
                          }
                        },
                        {
                          successMessage: "Meeting invite code saved.",
                          clearInviteInput: true,
                        }
                      );
                    })
                  }
                  disabled={
                    isMeetingWorking ||
                    !onUpdateMeetingConfig ||
                    !meetingInviteCodeInput.trim()
                  }
                />
                <ActionButton
                  label="Clear"
                  variant="danger"
                  onPress={() =>
                    trigger(() => {
                      void runMeetingTask(
                        async () => {
                          if (!onUpdateMeetingConfig) {
                            throw new Error("Meeting controls unavailable.");
                          }
                          const next = await onUpdateMeetingConfig({
                            inviteCode: null,
                          });
                          if (!next) {
                            throw new Error("Meeting update rejected.");
                          }
                        },
                        { successMessage: "Meeting invite code cleared." }
                      );
                    })
                  }
                  disabled={
                    isMeetingWorking ||
                    !onUpdateMeetingConfig ||
                    !meetingRequiresInviteCode
                  }
                />
              </View>
              {meetingNotice ? (
                <Text style={styles.noticeText}>{meetingNotice}</Text>
              ) : null}
              {meetingError ? (
                <Text style={styles.errorText}>{meetingError}</Text>
              ) : null}
            </View>

            <SectionLabel label="Webinar" icon={<Radio size={12} color={SHEET_COLORS.textMuted} strokeWidth={2} />} />
            <View style={styles.listContent}>
              <Pressable
                onPress={() => trigger(() => setWebinarExpanded((value) => !value))}
                style={styles.row}
              >
                <View style={styles.rowLeft}>
                  <Text style={styles.rowTitle}>Webinar controls</Text>
                  <Text style={styles.rowSubtitle}>
                    {webinarEnabled
                      ? `${webinarConfig?.attendeeCount ?? 0} / ${webinarConfig?.maxAttendees ?? 500} attendees`
                      : "Off"}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  <Text
                    style={[
                      styles.rowValue,
                      webinarEnabled ? { color: ACCENT.coral.fg, fontWeight: "600" } : null,
                    ]}
                  >
                    {webinarEnabled ? "Live" : "Off"}
                  </Text>
                  {webinarExpanded ? (
                    <ChevronDown size={16} color={SHEET_COLORS.textFaint} strokeWidth={2.2} />
                  ) : (
                    <ChevronRight size={16} color={SHEET_COLORS.textFaint} strokeWidth={2.2} />
                  )}
                </View>
              </Pressable>
            </View>

            {webinarExpanded ? (
              <View style={styles.webinarPanel}>
                <View style={styles.listContent}>
                  <SettingRow
                    title="Webinar enabled"
                    value={webinarEnabled ? "On" : "Off"}
                    active={webinarEnabled}
                    accent="coral"
                    onPress={() =>
                      trigger(() => {
                        void runWebinarTask(
                          async () => {
                            if (!onUpdateWebinarConfig) {
                              throw new Error("Webinar controls unavailable.");
                            }
                            const next = await onUpdateWebinarConfig({
                              enabled: !webinarEnabled,
                            });
                            if (!next) {
                              throw new Error("Webinar update rejected.");
                            }
                          },
                          {
                            successMessage: webinarEnabled
                              ? "Webinar disabled."
                              : "Webinar enabled.",
                          }
                        );
                      })
                    }
                    disabled={isWebinarWorking || !onUpdateWebinarConfig}
                  />
                  <SettingRow
                    title="Public access"
                    value={webinarPublicAccess ? "Public" : "Private"}
                    active={webinarPublicAccess}
                    accent="green"
                    onPress={() =>
                      trigger(() => {
                        void runWebinarTask(
                          async () => {
                            if (!onUpdateWebinarConfig) {
                              throw new Error("Webinar controls unavailable.");
                            }
                            const next = await onUpdateWebinarConfig({
                              publicAccess: !webinarPublicAccess,
                            });
                            if (!next) {
                              throw new Error("Webinar update rejected.");
                            }
                          },
                          {
                            successMessage: webinarPublicAccess
                              ? "Public access disabled."
                              : "Public access enabled.",
                          }
                        );
                      })
                    }
                    disabled={
                      isWebinarWorking || !onUpdateWebinarConfig || !webinarEnabled
                    }
                  />
                  <SettingRow
                    title="Lock webinar"
                    value={webinarLocked ? "Locked" : "Open"}
                    active={webinarLocked}
                    accent="blue"
                    onPress={() =>
                      trigger(() => {
                        void runWebinarTask(
                          async () => {
                            if (!onUpdateWebinarConfig) {
                              throw new Error("Webinar controls unavailable.");
                            }
                            const next = await onUpdateWebinarConfig({
                              locked: !webinarLocked,
                            });
                            if (!next) {
                              throw new Error("Webinar update rejected.");
                            }
                          },
                          {
                            successMessage: webinarLocked
                              ? "Webinar unlocked."
                              : "Webinar locked.",
                          }
                        );
                      })
                    }
                    disabled={
                      isWebinarWorking || !onUpdateWebinarConfig || !webinarEnabled
                    }
                  />
                </View>

                <View style={styles.fieldCard}>
                  <Text style={styles.fieldHeaderText}>Attendee cap</Text>
                  <View style={styles.fieldRow}>
                    <TextInput
                      value={webinarCapInput}
                      onChangeText={setWebinarCapInput}
                      keyboardType="number-pad"
                      placeholder="Attendee cap"
                      placeholderTextColor={SHEET_COLORS.textFaint}
                      style={styles.input}
                    />
                    <ActionButton
                      label="Save"
                      variant="primary"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              if (webinarCapValue == null) {
                                throw new Error("Enter a valid attendee cap.");
                              }
                              const next = await onUpdateWebinarConfig({
                                maxAttendees: webinarCapValue,
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            { successMessage: "Attendee cap updated." }
                          );
                        })
                      }
                      disabled={
                        isWebinarWorking ||
                        !onUpdateWebinarConfig ||
                        !webinarEnabled ||
                        webinarCapValue == null
                      }
                    />
                  </View>
                </View>

                <View style={styles.fieldCard}>
                  <Text style={styles.fieldHeaderText}>Invite code</Text>
                  <View style={styles.fieldRow}>
                    <TextInput
                      value={webinarInviteCodeInput}
                      onChangeText={setWebinarInviteCodeInput}
                      placeholder="Invite code"
                      placeholderTextColor={SHEET_COLORS.textFaint}
                      style={styles.input}
                    />
                    <ActionButton
                      label="Save"
                      variant="primary"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              const next = await onUpdateWebinarConfig({
                                inviteCode: webinarInviteCodeInput.trim(),
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            {
                              successMessage: "Invite code saved.",
                              clearInviteInput: true,
                            }
                          );
                        })
                      }
                      disabled={
                        isWebinarWorking ||
                        !onUpdateWebinarConfig ||
                        !webinarEnabled ||
                        !webinarInviteCodeInput.trim()
                      }
                    />
                    <ActionButton
                      label="Clear"
                      variant="danger"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              const next = await onUpdateWebinarConfig({
                                inviteCode: null,
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            { successMessage: "Invite code cleared." }
                          );
                        })
                      }
                      disabled={
                        isWebinarWorking ||
                        !onUpdateWebinarConfig ||
                        !webinarRequiresInviteCode
                      }
                    />
                  </View>
                </View>

                <View style={styles.fieldCard}>
                  <Text style={styles.fieldHeaderText}>Invite link</Text>
                  <TextInput
                    value={webinarLink ?? ""}
                    editable={false}
                    placeholder="Generate webinar link"
                    placeholderTextColor={SHEET_COLORS.textFaint}
                    style={[styles.input, styles.readonlyInput]}
                  />
                  <View style={styles.fieldRow}>
                    <ActionButton
                      label="Generate"
                      variant="primary"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(async () => {
                            if (!onGenerateWebinarLink) {
                              throw new Error("Webinar link generation unavailable.");
                            }
                            const linkResponse = await onGenerateWebinarLink();
                            if (!linkResponse?.link) {
                              throw new Error("Webinar link unavailable.");
                            }
                            onSetWebinarLink?.(linkResponse.link);
                            await copyWebinarLink(linkResponse.link);
                          }, { successMessage: "Webinar link copied." });
                        })
                      }
                      disabled={
                        isWebinarWorking || !onGenerateWebinarLink || !webinarEnabled
                      }
                    />
                    <ActionButton
                      label="Rotate"
                      variant="danger"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(async () => {
                            if (!onRotateWebinarLink) {
                              throw new Error("Webinar link rotation unavailable.");
                            }
                            const linkResponse = await onRotateWebinarLink();
                            if (!linkResponse?.link) {
                              throw new Error("Webinar link unavailable.");
                            }
                            onSetWebinarLink?.(linkResponse.link);
                            await copyWebinarLink(linkResponse.link);
                          }, { successMessage: "Webinar link rotated and copied." });
                        })
                      }
                      disabled={
                        isWebinarWorking || !onRotateWebinarLink || !webinarEnabled
                      }
                    />
                    <ActionButton
                      label="Copy"
                      onPress={() =>
                        trigger(() => {
                          void runWebinarTask(async () => {
                            await copyWebinarLink(webinarLink ?? "");
                          }, { successMessage: "Webinar link copied." });
                        })
                      }
                      disabled={isWebinarWorking || !webinarLink}
                    />
                  </View>
                </View>

                {webinarNotice ? <Text style={styles.noticeText}>{webinarNotice}</Text> : null}
                {webinarError ? <Text style={styles.errorText}>{webinarError}</Text> : null}
              </View>
            ) : null}
          </>
        ) : null}

        <SectionLabel label="Microphone" icon={<Mic size={12} color={SHEET_COLORS.textMuted} strokeWidth={2} />} />
        <View style={styles.listContent}>
          {audioInputDevices.length === 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowTitle}>No microphones found</Text>
            </View>
          ) : (
            audioInputDevices.map((device, index) => {
              const isSelected =
                selectedAudioInputId != null
                  ? selectedAudioInputId === device.deviceId
                  : index === 0;
              return (
                <DeviceRow
                  key={`${device.deviceId || "audio-input"}-${index}`}
                  label={device.label}
                  selected={isSelected}
                  onPress={() => {
                    if (!onAudioInputDeviceChange) return;
                    trigger(() => onAudioInputDeviceChange(device.deviceId));
                  }}
                  disabled={!onAudioInputDeviceChange}
                />
              );
            })
          )}
        </View>

        <SectionLabel label="Speaker" icon={<Volume2 size={12} color={SHEET_COLORS.textMuted} strokeWidth={2} />} />
        <View style={styles.listContent}>
          {availableAudioOutputDevices.map((device, index) => {
            const isSelected =
              selectedAudioOutputId != null
                ? selectedAudioOutputId === device.deviceId
                : index === 0;
            return (
              <DeviceRow
                key={`${device.deviceId || "audio-output"}-${index}`}
                label={device.label}
                selected={isSelected}
                onPress={() => {
                  if (!onAudioOutputDeviceChange) return;
                  trigger(() => onAudioOutputDeviceChange(device.deviceId));
                }}
                disabled={!onAudioOutputDeviceChange}
              />
            );
          })}
        </View>

        {isLoadingAudioDevices ? (
          <Text style={styles.statusText}>Loading devices...</Text>
        ) : null}
        {audioDevicesError ? (
          <Text style={styles.errorText}>{audioDevicesError}</Text>
        ) : null}
      </ScrollView>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
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
    backgroundColor: "rgba(254, 252, 217, 0.08)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  closeText: {
    fontSize: 12,
    color: SHEET_COLORS.text,
  },
  quickActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  quickActionButton: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  quickActionPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.98 }],
  },
  quickActionActiveAmber: {
    borderColor: ACCENT.amber.bd,
    backgroundColor: ACCENT.amber.bg,
  },
  quickActionActiveBlue: {
    borderColor: ACCENT.blue.bd,
    backgroundColor: ACCENT.blue.bg,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionLabelText: {
    fontSize: 11,
    color: SHEET_COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  listContent: {
    gap: 8,
  },
  row: {
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowSelected: {
    borderColor: "rgba(249, 95, 74, 0.75)",
    backgroundColor: "rgba(249, 95, 74, 0.18)",
  },
  rowLeft: {
    flex: 1,
    minWidth: 0,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowTitle: {
    fontSize: 14,
    color: SHEET_COLORS.text,
    flexShrink: 1,
  },
  rowTitleSelected: {
    fontWeight: "600",
  },
  rowSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: SHEET_COLORS.textMuted,
  },
  rowValue: {
    fontSize: 12,
    color: SHEET_COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  rowDisabled: {
    opacity: 0.45,
  },
  webinarPanel: {
    gap: 8,
  },
  fieldCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  fieldHeaderText: {
    color: SHEET_COLORS.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  input: {
    flex: 1,
    minWidth: 140,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    borderRadius: 12,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: SHEET_COLORS.text,
    fontSize: 13,
  },
  readonlyInput: {
    opacity: 0.65,
  },
  actionButton: {
    borderWidth: 1,
    borderRadius: 12,
    minWidth: 72,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  actionDefault: {
    borderColor: SHEET_COLORS.border,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
  },
  actionPrimary: {
    borderColor: "rgba(249, 95, 74, 0.7)",
    backgroundColor: "rgba(249, 95, 74, 0.2)",
  },
  actionDanger: {
    borderColor: "rgba(96, 165, 250, 0.7)",
    backgroundColor: "rgba(96, 165, 250, 0.2)",
  },
  actionButtonText: {
    color: SHEET_COLORS.text,
    fontSize: 12,
    fontWeight: "600",
  },
  statusText: {
    marginTop: 4,
    color: SHEET_COLORS.textMuted,
    fontSize: 12,
  },
  noticeText: {
    color: "rgba(52, 211, 153, 0.95)",
    fontSize: 12,
  },
  errorText: {
    color: "#F95F4A",
    fontSize: 12,
  },
});
