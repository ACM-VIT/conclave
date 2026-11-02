// The page side of the native embed transport (S60 13 c, d). iOS: the page posts through the one
// `window.webkit.messageHandlers.conclaveApp` handler and native delivers with `callAsyncJavaScript` into
// `window.conclaveNativeEmbed.receive(message)`. Android: `WebViewCompat.addWebMessageListener` injects
// `window.conclaveApp` (origin-checked by the engine) with `postMessage` for the page and a `message` event for native
// replies. Nothing here can reach the network or any native method other than the one handler.

import { NATIVE_EMBED_HANDLER_NAME } from "./protocol";

type WebKitHandler = { postMessage: (message: string) => void };
type WebKitBridge = { messageHandlers?: Record<string, WebKitHandler | undefined> };
type AndroidMessageEvent = { data: unknown };
type AndroidBridge = {
  postMessage: (message: string) => void;
  addEventListener?: (type: "message", listener: (event: AndroidMessageEvent) => void) => void;
  onmessage?: ((event: AndroidMessageEvent) => void) | null;
};
type NativeReceiver = { receive: (message: unknown) => void };
type NativeWindow = Window & {
  webkit?: WebKitBridge;
  conclaveApp?: AndroidBridge;
  conclaveNativeEmbed?: NativeReceiver;
};

export type NativePlatform = "ios" | "android" | "none";

export type NativeTransport = {
  platform: NativePlatform;
  post: (message: string) => void;
  /** The handler returns why a message was dropped ("none" when handled); the platform ignores it. */
  onMessage: (handler: (raw: unknown) => unknown) => void;
};

/** Finds the platform channel. "none" (a desktop browser) posts nothing, so the embed stays inert outside the app. */
export const createNativeTransport = (target: Window): NativeTransport => {
  const host = target as NativeWindow;
  let handler: (raw: unknown) => unknown = () => "none";
  const receiver: NativeReceiver = {
    receive: (message: unknown) => {
      handler(message);
    },
  };
  Object.defineProperty(host, "conclaveNativeEmbed", { value: receiver, writable: false, configurable: false });

  const webkitHandler = host.webkit?.messageHandlers?.[NATIVE_EMBED_HANDLER_NAME];
  if (webkitHandler) {
    return {
      platform: "ios",
      post: (message) => webkitHandler.postMessage(message),
      onMessage: (next) => {
        handler = next;
      },
    };
  }

  const android = host.conclaveApp;
  if (android && typeof android.postMessage === "function") {
    const listen = (event: AndroidMessageEvent) => {
      handler(event.data);
    };
    if (typeof android.addEventListener === "function") {
      android.addEventListener("message", listen);
    } else {
      android.onmessage = listen;
    }
    return {
      platform: "android",
      post: (message) => android.postMessage(message),
      onMessage: (next) => {
        handler = next;
      },
    };
  }

  return {
    platform: "none",
    post: () => {},
    onMessage: (next) => {
      handler = next;
    },
  };
};
