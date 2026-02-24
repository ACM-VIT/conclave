import { AppState, PermissionsAndroid, Platform } from "react-native";
import notifee, {
  AuthorizationStatus,
  AndroidForegroundServiceType,
  AndroidImportance,
  AndroidVisibility,
} from "@notifee/react-native";
import * as Device from "expo-device";
import type { IOptions } from "react-native-callkeep";
import InCallManager from "react-native-incall-manager";
import {
  clearForegroundActionHandlers,
  setForegroundActionHandlers,
} from "./foreground-actions";

let callKeepReady = false;
let currentCallId: string | null = null;
let callKeepStartAtMs = 0;
let callKeepModule: typeof import("react-native-callkeep") | null = null;
let foregroundActionsCleanup: (() => void) | null = null;
let foregroundChannelPromise: Promise<string> | null = null;

const FOREGROUND_NOTIFICATION_ID = "conclave-call";
const FOREGROUND_ACTION_LEAVE = "leave";
const FOREGROUND_ACTION_OPEN = "open";
const FOREGROUND_ACTION_TOGGLE_MUTE = "toggle-mute";
const FOREGROUND_COLOR = "#F95F4A";
const IOS_CATEGORY_MUTED = "conclave-call-muted";
const IOS_CATEGORY_UNMUTED = "conclave-call-unmuted";
const IOS_AUDIO_SESSION_ALLOW_BLUETOOTH = 4;
const IOS_AUDIO_SESSION_ALLOW_BLUETOOTH_A2DP = 32;
let iosCategoriesConfigured = false;
const isIOSSimulator = Platform.OS === "ios" && !Device.isDevice;
type AudioRoute = "speaker" | "earpiece" | "auto";

const setForceSpeakerphone = (flag: boolean | null) => {
  (
    InCallManager as unknown as {
      setForceSpeakerphoneOn?: (nextFlag: boolean | null) => void;
    }
  ).setForceSpeakerphoneOn?.(flag);
};

const getCallKeep = () => {
  if (Platform.OS !== "ios" || isIOSSimulator) return null;
  if (!callKeepModule) {
    callKeepModule = require("react-native-callkeep");
  }
  return callKeepModule;
};

const getForegroundChannel = async () => {
  if (Platform.OS !== "android") return "";
  if (!foregroundChannelPromise) {
    foregroundChannelPromise = notifee.createChannel({
      id: "conclave-call",
      name: "Conclave Call",
      importance: AndroidImportance.HIGH,
    });
  }
  return foregroundChannelPromise;
};

const CALLKEEP_OPTIONS: IOptions = {
  ios: {
    appName: "Conclave",
    supportsVideo: true,
    audioSession: {
      categoryOptions:
        IOS_AUDIO_SESSION_ALLOW_BLUETOOTH |
        IOS_AUDIO_SESSION_ALLOW_BLUETOOTH_A2DP,
      mode: "AVAudioSessionModeVideoChat",
    },
  },
  android: {
    alertTitle: "Phone account required",
    alertDescription:
      "This app needs access to your phone accounts to manage calls.",
    cancelButton: "Cancel",
    okButton: "Ok",
    additionalPermissions: [],
  },
};

const createCallId = () => {
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
};

export async function ensureCallKeep() {
  const callKeep = getCallKeep();
  if (!callKeep) return;
  if (callKeepReady) return;
  try {
    await callKeep.default.setup(CALLKEEP_OPTIONS);
    callKeep.default.setAvailable(true);
    callKeepReady = true;
  } catch (error) {
    console.warn("[CallKeep] setup failed", error);
  }
}

export function startCallSession(handle: string, displayName: string) {
  const callKeep = getCallKeep();
  const callId = createCallId();
  currentCallId = callId;
  if (callKeep) {
    callKeep.default.startCall(callId, handle, displayName, "generic", true);
    callKeepStartAtMs = Date.now();
    try {
      callKeep.default.reportConnectingOutgoingCallWithUUID(callId);
      callKeep.default.reportConnectedOutgoingCallWithUUID(callId);
    } catch {}
    callKeep.default.setCurrentCallActive(callId);
  }
  return callId;
}

export function endCallSession(callId?: string) {
  const callKeep = getCallKeep();
  const id = callId || currentCallId;
  if (!id) return;
  if (callKeep) {
    callKeep.default.endCall(id);
  }
  if (currentCallId === id) currentCallId = null;
}

export function setCallMuted(muted: boolean) {
  const callKeep = getCallKeep();
  if (!callKeep || !currentCallId) return;
  try {
    callKeep.default.setMutedCall(currentCallId, muted);
  } catch {}
}

export function startInCall() {
  if (isIOSSimulator) return;
  // iOS call audio is managed by CallKeep/WebRTC to preserve Bluetooth routing.
  if (Platform.OS === "ios") return;
  InCallManager.start({ media: "video", auto: true });
  setAudioRoute("auto");
}

export function stopInCall() {
  if (isIOSSimulator) return;
  // Keep iOS teardown with CallKeep/WebRTC session handling.
  if (Platform.OS === "ios") return;
  InCallManager.stop();
}

export async function startForegroundCallService(options?: {
  roomId?: string;
  includeCamera?: boolean;
  isMuted?: boolean;
}) {
  try {
    if (Platform.OS !== "android") return;
    await ensureNotificationPermission();
    const foregroundServiceTypes = await getForegroundServiceTypes(
      options?.includeCamera ?? false
    );
    const notification = await buildForegroundNotification({
      ...options,
      foregroundServiceTypes,
    });
    await notifee.displayNotification(notification);
  } catch (error) {
    console.warn("[ForegroundService] start failed", error);
  }
}

export async function updateForegroundCallService(options?: {
  roomId?: string;
  includeCamera?: boolean;
  isMuted?: boolean;
}) {
  try {
    if (Platform.OS !== "android") return;
    await ensureNotificationPermission();
    const foregroundServiceTypes = await getForegroundServiceTypes(
      options?.includeCamera ?? false
    );
    const notification = await buildForegroundNotification({
      ...options,
      foregroundServiceTypes,
    });
    await notifee.displayNotification(notification);
  } catch (error) {
    console.warn("[ForegroundService] update failed", error);
  }
}

export async function ensureCallNotificationPermissionIOS() {
  if (Platform.OS !== "ios") return;
  await ensureNotificationPermission();
}

export async function startCallNotificationIOS(options?: {
  roomId?: string;
  isMuted?: boolean;
}) {
  try {
    if (Platform.OS !== "ios") return;
    await ensureIOSNotificationCategories();
    const notification = buildIOSCallNotification(options);
    await notifee.displayNotification(notification);
  } catch (error) {
    console.warn("[CallNotification] start failed", error);
  }
}

export async function updateCallNotificationIOS(options?: {
  roomId?: string;
  isMuted?: boolean;
}) {
  try {
    if (Platform.OS !== "ios") return;
    await ensureIOSNotificationCategories();
    const notification = buildIOSCallNotification(options);
    await notifee.displayNotification(notification);
  } catch (error) {
    console.warn("[CallNotification] update failed", error);
  }
}

export async function stopCallNotificationIOS() {
  try {
    if (Platform.OS !== "ios") return;
    await notifee.cancelNotification(FOREGROUND_NOTIFICATION_ID);
  } catch (error) {
    console.warn("[CallNotification] stop failed", error);
  }
}

export async function stopForegroundCallService() {
  try {
    if (Platform.OS !== "android") return;
    await notifee.stopForegroundService();
    await notifee.cancelNotification(FOREGROUND_NOTIFICATION_ID);
  } catch (error) {
    console.warn("[ForegroundService] stop failed", error);
  }
}

export function registerForegroundCallServiceHandlers(handlers: {
  onLeave?: () => void;
  onOpen?: () => void;
  onToggleMute?: () => void;
}) {
  if (foregroundActionsCleanup) {
    foregroundActionsCleanup();
    foregroundActionsCleanup = null;
  }
  setForegroundActionHandlers({
    onLeave: handlers.onLeave,
    onOpen: handlers.onOpen,
    onToggleMute: handlers.onToggleMute,
  });
  foregroundActionsCleanup = () => {
    clearForegroundActionHandlers();
  };

  return () => {
    if (foregroundActionsCleanup) {
      foregroundActionsCleanup();
      foregroundActionsCleanup = null;
    }
  };
}

export function setAudioRoute(route: AudioRoute) {
  if (isIOSSimulator) return;
  // Keep iOS on system-managed routing unless an explicit manual route is requested.
  if (Platform.OS === "ios" && route === "auto") return;
  if (route === "speaker") {
    setForceSpeakerphone(true);
    return;
  }
  if (route === "earpiece") {
    setForceSpeakerphone(false);
    return;
  }
  setForceSpeakerphone(null);
}

export function registerCallKeepHandlers(onHangup: () => void) {
  const callKeep = getCallKeep();
  if (!callKeep) {
    return () => {};
  }
  const handleEndCall = () => {
    const elapsed = Date.now() - callKeepStartAtMs;
    if (callKeepStartAtMs && elapsed < 3000) {
      console.warn("[CallKeep] Ignoring endCall shortly after start");
      return;
    }
    onHangup();
  };
  const endCallSub = callKeep.default.addEventListener(
    "endCall",
    handleEndCall
  );

  const appStateSub = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      callKeep.default.setAvailable(true);
    }
  });

  return () => {
    endCallSub.remove();
    appStateSub.remove();
  };
}

async function buildForegroundNotification(options?: {
  roomId?: string;
  foregroundServiceTypes?: AndroidForegroundServiceType[];
  isMuted?: boolean;
}) {
  const channelId = await getForegroundChannel();
  const roomId = options?.roomId?.trim();
  const message = roomId ? `Meeting code: ${roomId}` : "Meeting in progress";
  const muteTitle = options?.isMuted ? "Unmute" : "Mute";
  return {
    id: FOREGROUND_NOTIFICATION_ID,
    title: "Conclave",
    body: message,
    android: {
      channelId,
      asForegroundService: true,
      color: FOREGROUND_COLOR,
      colorized: true,
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      smallIcon: "ic_notification",
      ongoing: true,
      onlyAlertOnce: true,
      foregroundServiceTypes: options?.foregroundServiceTypes,
      pressAction: {
        id: FOREGROUND_ACTION_OPEN,
        launchActivity: "default",
      },
      actions: [
        {
          title: "Leave",
          pressAction: { id: FOREGROUND_ACTION_LEAVE, launchActivity: "default" },
        },
        {
          title: muteTitle,
          pressAction: { id: FOREGROUND_ACTION_TOGGLE_MUTE, launchActivity: "default" },
        },
      ],
    },
  };
}

function buildIOSCallNotification(options?: { roomId?: string; isMuted?: boolean }) {
  const roomId = options?.roomId?.trim();
  const message = roomId ? `Meeting code: ${roomId}` : "Meeting in progress";
  return {
    id: FOREGROUND_NOTIFICATION_ID,
    title: "Conclave",
    body: message,
    ios: {
      categoryId: options?.isMuted ? IOS_CATEGORY_MUTED : IOS_CATEGORY_UNMUTED,
      sound: "default",
    },
  };
}

async function getForegroundServiceTypes(includeCamera: boolean) {
  const types = [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE];
  if (!includeCamera) return types;

  try {
    const hasCameraPermission = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.CAMERA
    );
    if (hasCameraPermission) {
      types.unshift(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CAMERA);
    }
  } catch (error) {
    console.warn("[ForegroundService] camera permission check failed", error);
  }

  return types;
}

async function ensureNotificationPermission() {
  try {
    const settings = await notifee.getNotificationSettings();
    if (settings.authorizationStatus === AuthorizationStatus.AUTHORIZED) return;
    await notifee.requestPermission();
  } catch (error) {
    console.warn("[ForegroundService] notification permission check failed", error);
  }
}

async function ensureIOSNotificationCategories() {
  if (Platform.OS !== "ios") return;
  if (iosCategoriesConfigured) return;
  await notifee.setNotificationCategories([
    {
      id: IOS_CATEGORY_UNMUTED,
      actions: [
        { id: FOREGROUND_ACTION_LEAVE, title: "Leave", foreground: true },
        { id: FOREGROUND_ACTION_TOGGLE_MUTE, title: "Mute", foreground: true },
      ],
    },
    {
      id: IOS_CATEGORY_MUTED,
      actions: [
        { id: FOREGROUND_ACTION_LEAVE, title: "Leave", foreground: true },
        { id: FOREGROUND_ACTION_TOGGLE_MUTE, title: "Unmute", foreground: true },
      ],
    },
  ]);
  iosCategoriesConfigured = true;
}
