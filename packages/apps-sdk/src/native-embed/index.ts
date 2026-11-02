// The native embed (S60 0.8 C6-19, ACT-7): one scoped, versioned bridge between a bundled SDK renderer in the native
// app's web view and the native host. The page bundles are built by `pnpm -C packages/apps-sdk run build:native-embed`
// (build/build-native-embed.mjs); the contract is pinned by `pnpm -C packages/apps-sdk run test:native-embed`.

export * from "./protocol";
export { createNativeTransport, type NativePlatform, type NativeTransport } from "./bridge";
export {
  NativeEmbedSession,
  payloadBoolean,
  payloadNumber,
  payloadString,
  type CommandHandler,
  type CommandResult,
  type AppStatusPayload,
  type EmbedStatusPayload,
  type HostStatus,
  type WatchAppStatus,
  type WheelAppStatus,
} from "./session";
