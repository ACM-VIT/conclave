import { AppState, Platform } from "react-native";
import type { IOptions } from "react-native-callkeep";
import InCallManager from "react-native-incall-manager";

let callKeepReady = false;
let currentCallId: string | null = null;
let callKeepModule: typeof import("react-native-callkeep") | null = null;

const getCallKeep = () => {
  if (Platform.OS !== "ios") return null;
  if (!callKeepModule) {
    callKeepModule = require("react-native-callkeep");
  }
  return callKeepModule;
};

const CALLKEEP_OPTIONS: IOptions = {
  ios: {
    appName: "Conclave",
    supportsVideo: true,
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

export function startInCall() {
  InCallManager.start({ media: "video" });
  InCallManager.setForceSpeakerphoneOn?.(true);
}

export function stopInCall() {
  InCallManager.stop();
}

export function setAudioRoute(route: "speaker" | "earpiece") {
  if (route === "speaker") {
    InCallManager.setForceSpeakerphoneOn?.(true);
  } else {
    InCallManager.setForceSpeakerphoneOn?.(false);
  }
}

export function registerCallKeepHandlers(onHangup: () => void) {
  const callKeep = getCallKeep();
  if (!callKeep) {
    return () => {};
  }
  const handleEndCall = () => {
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
