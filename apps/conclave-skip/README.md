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

Both work on the default Swift 6.4 build engine. The app is Skip Lite only
(transpiled); do not add `skip-fuse` back.

Android uses the checked-in Gradle wrapper (Gradle 9.7.1) and is verified with
JDK 21, so pin `JAVA_HOME`:

```sh
cd Android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew :Conclave:compileDebugKotlin --console=plain
ALLOW_DEBUG_RELEASE_SIGNING=true ./gradlew :app:assembleRelease --console=plain
```

The release APK is written to
`.build/Android/app/outputs/apk/release/app-release.apk`.
`ALLOW_DEBUG_RELEASE_SIGNING=true` signs it with the debug key when
`Android/app/keystore.properties` is absent; use that only for local
throwaway artifacts. On a fresh clone run `swift build` first so the Gradle
prebuild can use the package-pinned skip CLI from `.build/artifacts`.

iOS builds (`SKIP_ACTION=none` stops the "Run skip gradle" phase from
launching Gradle):

```sh
xcodebuild -project Darwin/Conclave.xcodeproj -scheme "Conclave App" -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build SKIP_ZERO=1 SKIP_ACTION=none
xcodebuild -project Darwin/Conclave.xcodeproj -scheme "Conclave App" -configuration Release -destination generic/platform=iOS -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build SKIP_ZERO=1 SKIP_ACTION=none
```

Use `Darwin/fastlane` and `Android/fastlane` for release automation. Release builds should use the production Conclave host from `Skip.env`, not emulator loopback URLs. `Android/fastlane` and the Xcode "Run skip gradle" phase (a normal Xcode Run) build through the checked-in Gradle wrapper and default `JAVA_HOME` to the Homebrew JDK 21, so no Homebrew Gradle is needed.

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
