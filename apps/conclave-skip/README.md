# Conclave Native

Conclave's native app lives here. The shared Swift source is compiled for iOS and transpiled through Skip for Android; keep behavior aligned with the web client while making platform-specific media, permission, and release handling explicit.

## Structure

- `Sources/Conclave`: shared SwiftUI, meeting state, networking, WebRTC, and platform bridges.
- `Sources/Conclave/Skip`: Android-only Kotlin helpers used by the Skip build.
- `Darwin`: iOS app target, assets, entitlements, ReplayKit screen-share extension, and fastlane release config.
- `Android`: Android Gradle project, manifest, resources, native Kotlin entry points, and fastlane release config.
- `Skip.env`: shared app identity, version/build numbers, bundle ids, and production backend URLs.

Do not use `apps/mobile` for new native work; it is deprecated.

## Build And Test

From this directory:

```sh
swift build
swift test -q
```

Android compile check:

```sh
cd Android
gradle --no-daemon --max-workers=1 -Dorg.gradle.jvmargs='-Xmx1536m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8' :Conclave:compileDebugKotlin --console=plain
```

iOS simulator build:

```sh
xcodebuild -project Darwin/Conclave.xcodeproj -scheme "Conclave App" -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO build
```

Use `Darwin/fastlane` and `Android/fastlane` for release automation. Release builds should use the production Conclave host from `Skip.env`, not emulator loopback URLs.

## Runtime Notes

- Native auth, SFU join, socket events, media lifecycle, and admin controls should follow `apps/web` behavior unless a platform API forces a documented difference.
- iOS whole-screen sharing uses the ReplayKit broadcast extension in `Darwin/ScreenShareExtension`.
- Android screen sharing uses MediaProjection plus a foreground service; do not start WebRTC screen capture before the service is foregrounded.
- Android call audio routing must preserve microphone capture across speaker, earpiece, wired, Bluetooth, and background call states.

## Verification Expectations

For meeting changes, run the smallest relevant native checks and, when a device is visible, smoke test:

- solo join shows one participant and no duplicate self tile
- another participant appears with the correct display name
- mic/camera toggles recover after permission denial or route change
- leave/reconnect cleans producers, consumers, transports, and room UI state
