# Conclave Native

Shared SwiftUI client compiled natively for iOS and transpiled to Kotlin/Compose for Android via Skip Lite. Keep meeting behavior aligned with `apps/web` while handling platform media, permissions, and releases explicitly.

## Layout

- `Sources/Conclave`: shared SwiftUI views, meeting state, networking, WebRTC, and platform bridges.
- `Sources/Conclave/Skip`: Android-only Kotlin helpers for the Skip build.
- `Darwin`: iOS Xcode project, assets, entitlements, ReplayKit screen-share extension (`Darwin/ScreenShareExtension`), and fastlane config.
- `Android`: Gradle project (wrapper pinned to Gradle 9.9.2), manifest, resources, Kotlin entry points, and fastlane config.
- [`Skip.env`](./Skip.env): app identity, version/build numbers, bundle IDs, and production backend URLs.

## Build and Test

### Swift Package

From `apps/conclave-skip` (works on the default Swift 6.4 build engine; Skip Lite only, do not re-add `skip-fuse`):

```sh
swift build
swift test -q
```

### Android

Requires JDK 21 and Android SDK Platform 37 (for OkHttp 5.5). On a fresh clone, run `swift build` first so Gradle's prebuild can pick up the pinned `skip` CLI from `.build/artifacts`.

```sh
cd Android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew :Conclave:compileDebugKotlin --console=plain
ALLOW_DEBUG_RELEASE_SIGNING=true ./gradlew :app:assembleRelease --console=plain
```

- Output APK: `.build/Android/app/outputs/apk/release/app-release.apk`.
- `ALLOW_DEBUG_RELEASE_SIGNING=true` signs with the debug key when `Android/app/keystore.properties` is absent. Use it only for local throwaway builds.
- Both `Android/fastlane` and Xcode's "Run skip gradle" phase invoke the checked-in Gradle wrapper and default `JAVA_HOME` to Homebrew JDK 21, so a separate Gradle install is not required.

### iOS

`SKIP_ACTION=none` prevents Xcode's "Run skip gradle" build phase from launching Gradle during iOS-only builds:

```sh
xcodebuild -project Darwin/Conclave.xcodeproj -scheme "Conclave App" -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build SKIP_ZERO=1 SKIP_ACTION=none
xcodebuild -project Darwin/Conclave.xcodeproj -scheme "Conclave App" -configuration Release -destination generic/platform=iOS -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build SKIP_ZERO=1 SKIP_ACTION=none
```

### Releases

Use `Darwin/fastlane` and `Android/fastlane`. Release builds must point to the production Conclave host in [`Skip.env`](./Skip.env), never emulator loopback URLs.

## Platform Notes

- Mirror `apps/web` for auth, SFU join, socket events, media lifecycle, and admin controls unless a platform API requires a documented difference.
- iOS whole-screen sharing runs through the ReplayKit broadcast extension in [`Darwin/ScreenShareExtension`](./Darwin/ScreenShareExtension).
- Android screen sharing uses `MediaProjection` with a foreground service. Start the foreground service before starting WebRTC screen capture.
- Android audio routing must keep mic capture alive across speaker, earpiece, wired headset, Bluetooth, and background transitions.
- Android Google Sign-In uses Credential Manager with the web OAuth client ID in `Skip.env`.

## Smoke Test Checklist

For meeting changes, run the relevant automated checks and, with a simulator or device open, verify:

- Solo join renders one participant with no duplicate self tile.
- A second participant joins with the expected display name.
- Mic and camera toggles recover cleanly after permission denial or audio route changes.
- Leaving and rejoining tears down and recreates producers, consumers, transports, and room UI state.
