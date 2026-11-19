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
  onMessage: (handler: (raw: unknown) => unknown) => void;
};

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
