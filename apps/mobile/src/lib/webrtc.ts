import * as mediasoupClient from "mediasoup-client";
import { registerGlobals as registerWebRTCGlobals } from "react-native-webrtc";

let registered = false;

export function ensureWebRTCGlobals() {
  if (registered) return;
  registerWebRTCGlobals();
  const maybeRegister = (mediasoupClient as { registerGlobals?: () => void })
    .registerGlobals;
  if (maybeRegister) {
    maybeRegister();
  }
  registered = true;
}
